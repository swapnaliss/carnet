// `rfi.sync` (M2-04): fetch the RFI (the webhook carries only `{id, type}`) and ingest it. The webhook
// payload's status is never read. Ingest runs in one transaction per RFI, serialised per business by an
// advisory lock (the per-source guard, ADR 0018 amendment 1), with the row locked:
//   1. attribute the RFI to a business (packages/db rfi-attribution.ts)
//   2. drop it when the fetched version is not newer than the stored one (stale or duplicate)
//   3. plan the state-machine steps from the snapshot (planRfiIngest, packages/domain)
//   4. store the RFI, match it to a payment (or the orphan queue), insert new questions (insert-only),
//      audit every transition and link change, and enqueue `rfi.draft` on entering DRAFTING (outbox)
// It never reads or writes a payment's transfer state: an RFI never changes a money status (ADR 0006).
import type { Rfi as AirwallexRfi, RfiQuestion as AirwallexRfiQuestion } from "@carnet/airwallex";
import {
  appendAudit,
  attributeRfi,
  enqueueJob,
  findOpenRfiBySourceKey,
  getRfiByAirwallexIdForUpdate,
  insertRfi,
  insertRfiQuestions,
  lockRfiIngest,
  markWebhookEventProcessed,
  type NewRfiQuestion,
  paymentIdsByTransferIds,
  type RepoCtx,
  type Rfi,
  repoCtx,
  updateRfi,
  withTransaction,
} from "@carnet/db";
import {
  type BusinessId,
  matchRfiToPayment,
  type PaymentId,
  planRfiIngest,
  RFI_TERMINAL_STATES,
  type RfiMatch,
  type RfiSnapshot,
  rfiSourceKey,
} from "@carnet/domain";
import {
  type HandlerContext,
  type JobHandler,
  payloadOptionalString,
  payloadString,
} from "./index";
import { parseAirwallexTime } from "./transfer";

/** Enqueued in the transaction that enters DRAFTING; consumed by handlers/draft.ts (M2-05). */
export const RFI_DRAFT_JOB_KIND = "rfi.draft";
export interface RfiDraftJobPayload {
  businessId: BusinessId;
  rfiId: string;
  round: number;
}

export type RfiIngestOutcome =
  | { outcome: "unattributed" }
  | { outcome: "stale" | "duplicate" | "terminal"; rfiId: string }
  | { outcome: "applied"; rfiId: string; state: string; round: number; created: boolean };

const ACTOR = { actorType: "system", actorId: "worker" } as const;

interface Round {
  round: number;
  questions: AirwallexRfiQuestion[];
  /** The open request: its questions need drafting. */
  active: boolean;
}

/**
 * The RFI's rounds, oldest first. `answered_requests` lists the newest first (OBSERVED,
 * rfi-followup-fetch-after-respond), so it is reversed; the active request is the latest round.
 */
export function roundsOf(rfi: AirwallexRfi): Round[] {
  const answered = [...rfi.answeredRequests].reverse();
  const rounds: Round[] = answered.map((r, i) => ({
    round: i + 1,
    questions: r.questions,
    active: false,
  }));
  if (rfi.activeRequest) {
    rounds.push({
      round: answered.length + 1,
      questions: rfi.activeRequest.questions,
      active: rfi.status === "ACTION_REQUIRED",
    });
  }
  return rounds;
}

export function snapshotOf(rfi: AirwallexRfi): RfiSnapshot {
  const newest = rfi.answeredRequests[0];
  return {
    status: rfi.status,
    updatedAt: parseAirwallexTime(rfi.updatedAt),
    answeredRequests: rfi.answeredRequests.length,
    newestAnsweredHasAnswers:
      newest !== undefined &&
      newest.questions.length > 0 &&
      newest.questions.every((q) => q.answer !== null),
  };
}

function questionRows(rounds: Round[]): NewRfiQuestion[] {
  const seen = new Set<string>();
  const rows: NewRfiQuestion[] = [];
  for (const r of rounds) {
    r.questions.forEach((q, position) => {
      rows.push({
        round: r.round,
        airwallexQuestionId: q.id,
        position,
        title: q.title,
        description: q.description,
        comment: q.comment,
        answerType: q.answerType,
        sources: q.sources,
        reopened: seen.has(q.id),
        needsDrafting: r.active,
      });
    });
    for (const q of r.questions) seen.add(q.id);
  }
  return rows;
}

function allQuestions(rfi: AirwallexRfi): AirwallexRfiQuestion[] {
  return [
    ...(rfi.activeRequest?.questions ?? []),
    ...rfi.answeredRequests.flatMap((r) => r.questions),
  ];
}

function transferIdsOf(questions: AirwallexRfiQuestion[]): string[] {
  return [
    ...new Set(
      questions.flatMap((q) => q.sources.filter((s) => s.type === "TRANSFER").map((s) => s.id)),
    ),
  ];
}

async function matchWithin(
  rc: RepoCtx,
  questions: AirwallexRfiQuestion[],
): Promise<RfiMatch<PaymentId>> {
  const byTransfer = await paymentIdsByTransferIds(rc, transferIdsOf(questions));
  return matchRfiToPayment(questions, (id) => byTransfer.get(id) ?? null);
}

function linkFields(m: RfiMatch<PaymentId>) {
  return m.kind === "linked"
    ? { paymentId: m.paymentId, orphanReason: null, linkedBy: "match" as const }
    : { paymentId: null, orphanReason: m.reason, linkedBy: null };
}

async function auditLink(
  rc: RepoCtx,
  rfi: Rfi,
  before: { paymentId: PaymentId | null; orphanReason: string | null } | null,
): Promise<void> {
  if (before && before.paymentId === rfi.paymentId && before.orphanReason === rfi.orphanReason)
    return;
  const subject = `rfi:${rfi.id}`;
  if (before?.paymentId && before.paymentId !== rfi.paymentId) {
    await appendAudit(rc, {
      ...ACTOR,
      action: "rfi.unlinked",
      subject,
      data: { paymentId: before.paymentId, by: "match" },
    });
  }
  if (rfi.paymentId) {
    await appendAudit(rc, {
      ...ACTOR,
      action: "rfi.linked",
      subject,
      data: { paymentId: rfi.paymentId, by: "match" },
    });
  } else {
    await appendAudit(rc, {
      ...ACTOR,
      action: "rfi.orphaned",
      subject,
      data: { reason: rfi.orphanReason },
    });
  }
}

/** Ingests one fetched RFI. Idempotent: a repeat of the same snapshot is a no-op. */
export async function ingestRfi(
  ctx: HandlerContext,
  fetched: AirwallexRfi,
  source: "webhook" | "reconcile",
): Promise<RfiIngestOutcome> {
  const questions = allQuestions(fetched);
  const attribution = await attributeRfi(ctx.db, {
    airwallexRfiId: fetched.id,
    accountId: fetched.accountId,
    transferIds: transferIdsOf(questions),
  });
  if (attribution.businessId === null) {
    ctx.logger.warn(
      { rfiId: fetched.id, accountId: fetched.accountId, alert: "rfi_unattributed", source },
      "rfi matches no business (no stored row, account mapping or transfer owner); not stored",
    );
    return { outcome: "unattributed" };
  }
  const businessId = attribution.businessId;
  const snap = snapshotOf(fetched);

  return withTransaction(ctx.db, async (tx) => {
    const rc = repoCtx(tx, businessId);
    await lockRfiIngest(tx, businessId);
    const stored = await getRfiByAirwallexIdForUpdate(rc, fetched.id);
    const plan = planRfiIngest(
      stored
        ? {
            state: stored.state,
            round: stored.round,
            version: {
              status: stored.airwallexStatus,
              updatedAt: stored.airwallexUpdatedAt,
              answeredRequests: stored.airwallexAnsweredRequests,
            },
          }
        : null,
      snap,
    );
    const version = {
      airwallexStatus: snap.status,
      airwallexUpdatedAt: snap.updatedAt,
      airwallexAnsweredRequests: snap.answeredRequests,
    };
    if (plan.outcome === "stale" || plan.outcome === "duplicate") {
      ctx.logger.debug(
        { rfiId: fetched.id, outcome: plan.outcome, source },
        "rfi snapshot not newer than stored; dropped",
      );
      return { outcome: plan.outcome, rfiId: stored?.id ?? "" };
    }
    if (plan.outcome === "terminal" && stored) {
      await updateRfi(rc, stored.id, version);
      ctx.logger.info(
        { rfiId: stored.id, state: stored.state, airwallexStatus: snap.status, source },
        "rfi already closed or expired in Carnet; newer snapshot recorded only",
      );
      return { outcome: "terminal", rfiId: stored.id };
    }
    if (plan.outcome !== "apply") throw new Error(`unexpected ingest plan ${plan.outcome}`);

    const expiresAt = fetched.activeRequest?.expiresAt
      ? parseAirwallexTime(fetched.activeRequest.expiresAt)
      : null;
    const sourceKey = rfiSourceKey(questions);
    // An owner's explicit link is kept; otherwise the RFI is (re)matched against this business only.
    const link =
      stored?.linkedBy === "owner"
        ? {
            paymentId: stored.paymentId,
            orphanReason: stored.orphanReason,
            linkedBy: stored.linkedBy,
          }
        : linkFields(await matchWithin(rc, questions));

    // ADR 0018 amendment 1: a second open RFI for the same type and source is stored, flagged and
    // surfaced, never merged, and never drafted (it does not enter DRAFTING while the first is open).
    const rival =
      sourceKey !== null && !RFI_TERMINAL_STATES.includes(plan.finalState)
        ? await findOpenRfiBySourceKey(rc, {
            type: fetched.type,
            sourceKey,
            ...(stored ? { excludeId: stored.id } : {}),
          })
        : null;
    const parked = rival !== null && plan.finalState === "DRAFTING";
    const steps = parked ? [] : plan.steps;
    const finalState = parked ? (stored?.state ?? "ACTION_REQUIRED") : plan.finalState;

    let row: Rfi;
    if (!stored) {
      row = await insertRfi(rc, {
        airwallexRfiId: fetched.id,
        type: fetched.type,
        subType: fetched.subType,
        ...version,
        state: finalState,
        round: plan.round,
        expiresAt,
        ...link,
        sourceKey,
        conflict: rival !== null,
      });
      await appendAudit(rc, {
        ...ACTOR,
        action: "rfi.created",
        subject: `rfi:${row.id}`,
        data: {
          airwallexRfiId: fetched.id,
          airwallexStatus: snap.status,
          round: plan.round,
          source,
        },
      });
      if (rival) {
        await appendAudit(rc, {
          ...ACTOR,
          action: "rfi.conflict",
          subject: `rfi:${row.id}`,
          data: { sourceKey, openRfiId: rival.id, type: fetched.type },
        });
        ctx.logger.warn(
          { rfiId: row.id, openRfiId: rival.id, sourceKey, alert: "rfi_conflict" },
          "a second open RFI for the same type and source; stored and flagged, not merged",
        );
      }
      await auditLink(rc, row, null);
    } else {
      const updated = await updateRfi(rc, stored.id, {
        ...version,
        state: finalState,
        round: plan.round,
        expiresAt,
        ...link,
        sourceKey,
        conflict: rival !== null,
      });
      if (!updated) throw new Error(`rfi ${stored.id} vanished under lock`);
      row = updated;
      await auditLink(rc, row, stored);
    }

    await insertRfiQuestions(rc, row.id, questionRows(roundsOf(fetched)));

    let from = stored?.state ?? "ACTION_REQUIRED";
    for (const step of steps) {
      if (step.from !== from) throw new Error(`ingest plan out of sequence at ${step.from}`);
      await appendAudit(rc, {
        ...ACTOR,
        action: "rfi.transition",
        subject: `rfi:${row.id}`,
        data: { from: step.from, to: step.to, event: step.event, round: plan.round, source },
      });
      if (step.enqueueDraft) {
        const payload: RfiDraftJobPayload = { businessId, rfiId: row.id, round: plan.round };
        await enqueueJob(tx, { kind: RFI_DRAFT_JOB_KIND, payload });
      }
      from = step.to;
    }
    ctx.logger.info(
      {
        rfiId: row.id,
        airwallexRfiId: fetched.id,
        from: stored?.state ?? null,
        to: finalState,
        round: plan.round,
        paymentId: row.paymentId,
        orphanReason: row.orphanReason,
        source,
      },
      "rfi ingested",
    );
    return {
      outcome: "applied",
      rfiId: row.id,
      state: finalState,
      round: plan.round,
      created: !stored,
    };
  });
}

/** Payload: `{ rfiId, webhookEventId? }` (the Airwallex RFI id). */
export const handleRfiSync: JobHandler = async (payload, ctx) => {
  const rfiId = payloadString(payload, "rfiId");
  const rfi = await ctx.airwallex.getRfi(rfiId);
  await ingestRfi(ctx, rfi, "webhook");
  const eventId = payloadOptionalString(payload, "webhookEventId");
  if (eventId) await markWebhookEventProcessed(ctx.db, eventId);
};
