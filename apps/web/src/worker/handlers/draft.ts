// `rfi.draft` (M2-05, ADR 0005, 0010): drafts the answers to an RFI round through the agent harness,
// verifies them in code, stores the draft (insert-only), moves the RFI DRAFTING -> DRAFT_READY |
// NEEDS_OWNER through the state machine with an `rfi.transition` audit row, and publishes `draft.ready`
// or `draft.needs_owner`, all in one transaction. Idempotent: a retry replays the model's stored output
// (no second call) and the draft is keyed by the job id, so one job stores at most one draft.
import {
  createHarness,
  DEFAULT_LIMITS,
  type DraftInput,
  type DraftingStore,
  isModelId,
  priorAnswersFor,
  reusedFrom,
  runDrafting,
  runDraftTimeout,
  type Transport,
} from "@carnet/agent";
import {
  agentHarnessStore,
  appendAudit,
  enqueueJob,
  findReusableForRound,
  getLatestDraft,
  getRfi,
  getRfiForUpdate,
  insertDraft,
  listRfiQuestions,
  listStuckDraftingRfis,
  loadDraftingEvidence,
  repoCtx,
  updateRfi,
  withTransaction,
} from "@carnet/db";
import { type BusinessId, type RfiId, transitionRfi } from "@carnet/domain";
import { type HandlerContext, type JobHandler, payloadString } from "./index";
import { RFI_DRAFT_JOB_KIND } from "./rfi";

export { RFI_DRAFT_JOB_KIND };
export const DRAFT_EVENT_KIND = {
  ready: "draft.ready",
  needsOwner: "draft.needs_owner",
} as const;

export interface DraftEvent {
  readonly businessId: string;
  readonly rfiId: string;
  readonly round: number;
  readonly draftId: string;
  readonly state: "DRAFT_READY" | "NEEDS_OWNER";
}

const ACTOR = { actorType: "system", actorId: "worker" } as const;

export function draftingStoreFor(
  ctx: Pick<HandlerContext, "db">,
  businessId: BusinessId,
): DraftingStore {
  const repo = repoCtx(ctx.db, businessId);
  return {
    async loadInput(rfiId, round) {
      const rfi = await getRfi(repo, rfiId as RfiId);
      if (!rfi) return null;
      const rows = await listRfiQuestions(repo, rfi.id, round);
      const questions = rows.filter((q) => q.needsDrafting);
      if (rows.length === 0) return null;
      const evidence = await loadDraftingEvidence(repo);
      // Answer memory (M2-06): earlier approved answers to identical questions of this counterparty go to
      // the model as untrusted context; every statement still needs a current citation.
      const { matches } = await findReusableForRound(repo, rfi, round);
      const prior = priorAnswersFor(
        questions.map((q) => ({ id: q.id, title: q.title.en ?? q.title.zh ?? "" })),
        matches,
      );
      const input: DraftInput = {
        questions: questions.map((q) => ({
          id: q.id,
          title: q.title.en ?? q.title.zh ?? "",
          description: q.description.en ?? q.description.zh ?? "",
          comment: q.comment,
          answerType: q.answerType,
        })),
        facts: evidence.facts,
        documents: evidence.documents,
        ...(prior.length > 0 ? { priorAnswers: prior } : {}),
      };
      const hasDraft = (await getLatestDraft(repo, rfi.id, round)) !== null;
      return {
        input,
        awaitingDraft: rfi.state === "DRAFTING" && rfi.round === round && !hasDraft,
      };
    },
    async saveDraft({ rfiId, round, draftKey, runId, origin, result }) {
      return withTransaction(ctx.db, async (tx) => {
        const rc = repoCtx(tx, businessId);
        const rfi = await getRfiForUpdate(rc, rfiId as RfiId);
        if (!rfi) throw new Error(`rfi ${rfiId} vanished`);
        // A model answer word for word the remembered one is marked `reused` (it has still been verified).
        const marks = reusedFrom(
          result.results,
          (await findReusableForRound(rc, rfi, round)).matches,
        );
        const { draft, inserted } = await insertDraft(rc, {
          rfiId: rfi.id,
          round,
          origin,
          draftKey,
          promptVersion: result.promptVersion,
          model: result.model,
          inputHash: result.inputHash === "" ? null : result.inputHash,
          injectionFlags: result.injectionFlags,
          agentRunId: runId,
          // A rejected answer keeps its reason, never its text: nothing ungrounded is stored as an answer.
          answers: result.results.map((r) =>
            r.verdict.status === "NEEDS_OWNER"
              ? {
                  questionId: r.question_id,
                  text: "",
                  citations: [],
                  documentIds: [],
                  verdict: r.verdict,
                }
              : {
                  questionId: r.question_id,
                  text: r.answer.text,
                  citations: r.answer.citations,
                  documentIds: r.answer.document_ids,
                  verdict: r.verdict,
                  reused: marks.get(r.question_id) ?? null,
                },
          ),
        });
        if (inserted && rfi.state === "DRAFTING" && rfi.round === round) {
          const rule = transitionRfi("DRAFTING", draft.state);
          await updateRfi(rc, rfi.id, { state: draft.state });
          await appendAudit(rc, {
            ...ACTOR,
            action: "rfi.transition",
            subject: `rfi:${rfi.id}`,
            data: {
              from: "DRAFTING",
              to: draft.state,
              event: rule.event,
              round,
              source: "drafting",
              draftId: draft.id,
            },
          });
          const event: DraftEvent = {
            businessId,
            rfiId: rfi.id,
            round,
            draftId: draft.id,
            state: draft.state,
          };
          await enqueueJob(tx, {
            kind:
              draft.state === "DRAFT_READY" ? DRAFT_EVENT_KIND.ready : DRAFT_EVENT_KIND.needsOwner,
            payload: event,
          });
        }
        return { draftId: draft.id, state: draft.state, inserted };
      });
    },
  };
}

export interface DraftHandlerOptions {
  /** HTTP transport for the model client (tests replay recorded responses); default: global fetch. */
  readonly transport?: Transport;
}

export function createRfiDraftHandler(options: DraftHandlerOptions = {}): JobHandler {
  return async (payload, ctx, job) => {
    const businessId = payloadString(payload, "businessId") as BusinessId;
    const rfiId = payloadString(payload, "rfiId");
    const round = Number((payload as { round?: unknown }).round);
    if (!Number.isInteger(round) || round < 1) throw new Error("job payload is missing round");
    const harness = createHarness({
      store: agentHarnessStore(repoCtx(ctx.db, businessId)),
      ...(options.transport ? { transport: options.transport } : {}),
    });
    const configured = process.env.ANTHROPIC_MODEL_DRAFT;
    const model = configured && isModelId(configured) ? configured : undefined;
    const out = await runDrafting({
      harness,
      store: draftingStoreFor(ctx, businessId),
      rfiId,
      round,
      draftKey: job.id,
      ...(model ? { model } : {}),
    });
    ctx.logger.info({ businessId, rfiId, round, ...out }, "rfi drafted");
  };
}

export const handleRfiDraft: JobHandler = createRfiDraftHandler();

/** Acknowledges `draft.ready` / `draft.needs_owner` until M2-07 and M2-08 register their consumers. */
export const handleDraftEvent: JobHandler = async (payload, ctx) => {
  ctx.logger.info({ payload }, "draft stored");
};

/**
 * Moves RFIs that are still DRAFTING after the run limit (15 minutes, `DEFAULT_LIMITS.runTimeLimitMs`)
 * to NEEDS_OWNER with a system draft (`MODEL_UNAVAILABLE`, `draft_timeout`). Covers a crashed or DEAD
 * `rfi.draft` job, including jobs enqueued before this handler existed. Called from the reconcile pass.
 */
export async function sweepStuckDrafting(
  ctx: HandlerContext,
  options: { now?: Date; olderThanMs?: number } = {},
): Promise<number> {
  const cutoff = new Date(
    (options.now ?? new Date()).getTime() - (options.olderThanMs ?? DEFAULT_LIMITS.runTimeLimitMs),
  );
  let moved = 0;
  for (const stuck of await listStuckDraftingRfis(ctx.db, cutoff)) {
    try {
      const out = await runDraftTimeout({
        store: draftingStoreFor(ctx, stuck.businessId),
        rfiId: stuck.rfiId,
        round: stuck.round,
      });
      if (out.outcome === "drafted") moved += 1;
    } catch (error) {
      ctx.logger.warn(
        { rfiId: stuck.rfiId, error: error instanceof Error ? error.message : String(error) },
        "drafting sweeper failed for one RFI",
      );
    }
  }
  return moved;
}
