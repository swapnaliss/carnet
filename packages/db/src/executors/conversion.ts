// The conversion executor (M3-03, ADR 0007, 0008, 0011). Two ways in, one way out:
//
//   executeAutoConversion      a PROPOSED convert action the auto-FX policy ALLOWs
//   executeApprovedConversion  a convert action outside the policy, after a bound approval is consumed
//
//   kill switch checked ─▶ balances re-read ─▶ policy (or approval bounds) ─▶ FRESH single-use quote
//   ─▶ ONE transaction: AutoApproval (policy version + hash) | consumed approval, action state,
//      ExecutionAttempt INTENT with its request_id, the quote claimed ─▶ kill switch again
//   ─▶ attempt SENT_TO_AIRWALLEX ─▶ createConversion(same request_id, quote id)
//        ├─ 2xx ───────────────▶ CONFIRMED, action DONE
//        ├─ 4xx ───────────────▶ REJECTED, action FAILED (nothing was created)
//        └─ timeout / 5xx ─────▶ UNKNOWN: `resolveConversionAttempt` looks it up by request_id
//
// The attempt row (and its request_id) is committed before the outbound call; a request_id is minted
// once per intent and reused only to retry that intent. Quotes are single use in Carnet: each quote id is
// claimed in `fx_quote_uses` (primary key), and a claimed id is never sent again.
import {
  type AnySubject,
  type AttemptId,
  approvalHash,
  type BusinessId,
  type ConversionSubject,
  type Currency,
  type DenyReason,
  evaluateAutoApproval,
  intentOf,
  money,
  newAttemptId,
  newRequestId,
  type QuoteFacts,
  rateWithinBounds,
} from "@carnet/domain";
import { withTransaction } from "../client";
import {
  getStoredAction,
  isActionCurrent,
  noteAction,
  type StoredAction,
  transitionAction,
} from "../repos/action-states";
import { type Approval, consumeApproval, endApproval, getApproval } from "../repos/approvals";
import { appendAudit } from "../repos/audit-log";
import { repoCtx } from "../repos/context";
import {
  claimAttempt,
  createAttempt,
  getAttempt,
  releaseAttempt,
  updateAttemptStatus,
} from "../repos/execution-attempts";
import {
  autoApprovedTotalToday,
  claimQuote,
  getLatestPolicy,
  insertAutoApproval,
  lockAutoApprovals,
} from "../repos/policies";
import {
  type AttemptRecord,
  EXECUTOR_LEASE_MS,
  type ExecutorDeps,
  executionEnabled,
  loggerOf,
  nowOf,
  Rollback,
  recordOf,
  withoutLease,
} from "./common";
import { classifyFailure, type GatewayConversion, type GatewayQuote } from "./gateway";

/** The reason Carnet sends with a conversion (the value accepted in every M0-03 recording). */
export const CONVERSION_REASON = "payment to supplier";
/** Quotes are requested valid for fifteen minutes (the policy's freshness window is checked as well). */
const QUOTE_VALIDITY = "MIN_15" as const;
/** A UNKNOWN conversion that lookup does not find is re-sent, with the SAME request_id, after this. */
export const DEFAULT_UNKNOWN_RETRY_AFTER_MS = 5 * 60_000;

export type ConversionOutcome =
  | { outcome: "skipped"; reason: string }
  | { outcome: "denied"; reason: DenyReason | "NO_POLICY" | "QUOTE_REUSED"; detail: string }
  | { outcome: "refused"; reason: string; attemptId?: AttemptId }
  | { outcome: "confirmed"; attemptId: AttemptId; conversion: GatewayConversion }
  | { outcome: "unknown"; attemptId: AttemptId; error: string }
  | { outcome: "rejected"; attemptId: AttemptId; error: string };

/** The subject an approval for this conversion is bound to (M3-04 shows it; the executor re-derives it). */
export function buildConversionSubject(
  stored: StoredAction,
  who: { businessId: BusinessId; approverId: ConversionSubject["approverId"]; nonce: string },
): ConversionSubject | null {
  if (stored.action.kind !== "convert") return null;
  const p = stored.action.params;
  return {
    kind: "conversion",
    businessId: who.businessId,
    approverId: who.approverId,
    nonce: who.nonce,
    actionId: stored.id,
    planRevision: stored.revision,
    planContentHash: stored.planContentHash,
    sellCurrency: p.sell_currency,
    buyCurrency: p.buy_currency,
    sellMinor: p.sell_minor,
    rateLow: p.rate_low,
    rateHigh: p.rate_high,
  };
}

function quoteFactsOf(q: GatewayQuote, now: Date): QuoteFacts | null {
  if (!q.sellAmount || !q.buyAmount) return null;
  const issued = q.validFromAt === null ? now : new Date(q.validFromAt);
  return {
    sellCurrency: q.sellAmount.currency,
    buyCurrency: q.buyAmount.currency,
    sellMinor: q.sellAmount.minor,
    buyMinor: q.buyAmount.minor,
    issuedAt: Number.isNaN(issued.getTime()) ? now : issued,
  };
}

// --- automatic path ---------------------------------------------------------------------------

export async function executeAutoConversion(
  deps: ExecutorDeps,
  businessId: BusinessId,
  actionId: string,
): Promise<ConversionOutcome> {
  const log = loggerOf(deps);
  const rc = repoCtx(deps.db, businessId);
  // 1. The kill switch comes first: off means no attempt, no quote, no call.
  if (!(await executionEnabled(deps.db))) return { outcome: "skipped", reason: "KILL_SWITCH" };

  const stored = await getStoredAction(rc, actionId);
  if (!stored || stored.action.kind !== "convert") {
    return { outcome: "skipped", reason: "NOT_A_CONVERSION" };
  }
  // A crash after the transaction below left AUTO_APPROVED with its attempt: finish that one.
  if (stored.state === "AUTO_APPROVED" && stored.attemptId !== null) {
    return sendConversion(deps, businessId, stored, stored.attemptId as AttemptId);
  }
  if (stored.state !== "PROPOSED") return { outcome: "skipped", reason: `ACTION_${stored.state}` };
  if (!(await isActionCurrent(rc, stored))) return { outcome: "skipped", reason: "SUPERSEDED" };

  const policy = await getLatestPolicy(rc);
  if (policy === null) {
    await noteAction(rc, actionId, "NO_POLICY");
    return { outcome: "denied", reason: "NO_POLICY", detail: "the business has no policy" };
  }

  const intent = intentOf(stored.action);
  if (intent.kind !== "convert") return { outcome: "skipped", reason: "NOT_A_CONVERSION" };
  const now = nowOf(deps);
  // 2. Balances are re-read, never trusted from the plan (held funds can move them).
  const balances = (await deps.gateway.getBalances()).map((b) => ({
    currency: b.currency,
    availableMinor: b.available.minor,
  }));
  const swiftFee = deps.swiftPayoutFeeMinor?.(intent.buyCurrency) ?? 0n;
  const baseState = {
    now,
    balances,
    autoApprovedTodayMinor: await autoApprovedTotalToday(rc, intent.sellCurrency, now),
    swiftPayoutFeeMinor: swiftFee,
  };
  const pre = evaluateAutoApproval(intent, baseState, policy);
  if (pre.decision === "DENY") return deny(rc, actionId, pre.reason, pre.detail);

  // 3. A fresh single-use quote; a quote Carnet already used is refused and another is requested.
  for (let tries = 0; tries < 2; tries++) {
    const quote = await deps.gateway.createQuote({
      buyCurrency: intent.buyCurrency,
      sellCurrency: intent.sellCurrency,
      sellAmount: money(intent.sellMinor, intent.sellCurrency),
      validity: QUOTE_VALIDITY,
    });
    const facts = quoteFactsOf(quote, now);
    if (facts === null) return deny(rc, actionId, "QUOTE_MISMATCH", "the quote has no amounts");
    const withQuote = evaluateAutoApproval(intent, { ...baseState, quote: facts }, policy);
    if (withQuote.decision === "DENY") {
      return deny(rc, actionId, withQuote.reason, withQuote.detail);
    }

    // 4. One transaction: the AutoApproval, the action's new state, the attempt and the quote claim.
    const attemptId = newAttemptId();
    try {
      const attempt = await withTransaction(deps.db, async (tx) => {
        const t = repoCtx(tx, businessId);
        await lockAutoApprovals(t, intent.sellCurrency);
        // The daily total is read again under the lock: two executors cannot both pass the cap.
        const total = await autoApprovedTotalToday(t, intent.sellCurrency, now);
        const again = evaluateAutoApproval(
          intent,
          { ...baseState, autoApprovedTodayMinor: total, quote: facts },
          policy,
        );
        if (again.decision === "DENY") throw new Rollback(`DENY:${again.reason}:${again.detail}`);
        const created = await createAttempt(t, {
          id: attemptId,
          kind: "conversion",
          refId: actionId,
          requestId: newRequestId(),
        });
        if (!(await claimQuote(t, { quoteId: quote.quoteId, actionId, attemptId }))) {
          throw new Rollback("QUOTE_REUSED");
        }
        if (!(await transitionAction(t, actionId, ["PROPOSED"], "AUTO_APPROVED", { attemptId }))) {
          throw new Rollback("STATE_CHANGED");
        }
        await insertAutoApproval(t, {
          actionId,
          policyVersion: policy.version,
          policyHash: policy.hash,
          amountMinor: intent.sellMinor,
          currency: intent.sellCurrency,
          dailyTotalAfterMinor: again.dailyTotalAfterMinor,
        });
        await updateAttemptStatus(t, created.id, "INTENT", {
          quoteId: quote.quoteId,
          policyVersion: policy.version,
          policyHash: policy.hash,
        } satisfies AttemptRecord);
        await appendAudit(t, {
          actorType: "system",
          action: "conversion.auto_approved",
          subject: actionId,
          data: {
            attemptId,
            requestId: created.requestId,
            quoteId: quote.quoteId,
            policyVersion: policy.version,
            policyHash: policy.hash,
            sellMinor: intent.sellMinor.toString(),
            sellCurrency: intent.sellCurrency,
            dailyTotalAfterMinor: again.dailyTotalAfterMinor.toString(),
          },
        });
        return created;
      });
      log.info(
        { actionId, attemptId: attempt.id, requestId: attempt.requestId },
        "conversion auto-approved; attempt written before the call",
      );
      const after = await getStoredAction(rc, actionId);
      if (!after) throw new Error("action vanished");
      return sendConversion(deps, businessId, after, attempt.id);
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
      if (error.reason === "QUOTE_REUSED") continue; // request a fresh quote
      if (error.reason.startsWith("DENY:")) {
        const [, reason, ...detail] = error.reason.split(":");
        return deny(rc, actionId, reason as DenyReason, detail.join(":"));
      }
      return { outcome: "skipped", reason: error.reason };
    }
  }
  await noteAction(rc, actionId, "QUOTE_REUSED");
  return {
    outcome: "denied",
    reason: "QUOTE_REUSED",
    detail: "Airwallex returned a used quote twice",
  };
}

async function deny(
  rc: ReturnType<typeof repoCtx>,
  actionId: string,
  reason: DenyReason,
  detail: string,
): Promise<ConversionOutcome> {
  // The action stays PROPOSED and now needs a bound approval; the reason is shown to the owner.
  await noteAction(rc, actionId, reason);
  return { outcome: "denied", reason, detail };
}

// --- approved path -----------------------------------------------------------------------------

export interface ApprovedConversionInput {
  approvalId: Approval["id"];
  /** The hash the caller was told to execute (the job payload). */
  expectedHash: string;
}

export async function executeApprovedConversion(
  deps: ExecutorDeps,
  businessId: BusinessId,
  input: ApprovedConversionInput,
): Promise<ConversionOutcome> {
  const log = loggerOf(deps);
  const rc = repoCtx(deps.db, businessId);
  if (!(await executionEnabled(deps.db))) return { outcome: "skipped", reason: "KILL_SWITCH" };

  const approval = await getApproval(rc, input.approvalId);
  if (!approval || approval.kind !== "conversion")
    return { outcome: "refused", reason: "NOT_FOUND" };
  const actionId = approval.subjectRef;
  const stored = await getStoredAction(rc, actionId);
  if (!stored || stored.action.kind !== "convert")
    return { outcome: "refused", reason: "NO_ACTION" };
  // An approval bound to content that no longer matches the current revision cannot be consumed.
  if (stored.state === "SUPERSEDED" || !(await isActionCurrent(rc, stored))) {
    await endApproval(rc, approval.id, "REJECTED", "SUPERSEDED");
    return { outcome: "refused", reason: "SUPERSEDED" };
  }

  const consumed = await consumeApproval(rc, {
    approvalId: input.approvalId,
    expectedHash: input.expectedHash,
    inTransaction: async (tx, a, attempt) => {
      const moved = await transitionAction(tx, actionId, ["PROPOSED", "APPROVED"], "EXECUTING", {
        attemptId: attempt.id,
      });
      if (!moved) throw new Rollback("ACTION_NOT_EXECUTABLE");
      await appendAudit(tx, {
        actorType: "system",
        actorId: a.approverId,
        action: "conversion.approval_consumed",
        subject: actionId,
        data: {
          approvalId: a.id,
          hash: a.hash,
          attemptId: attempt.id,
          requestId: attempt.requestId,
        },
      });
    },
  }).catch((error: unknown) => {
    if (error instanceof Rollback) return { outcome: "refused", reason: error.reason } as const;
    throw error;
  });
  if (consumed.outcome === "refused") return { outcome: "refused", reason: consumed.reason };

  const attempt = consumed.attempt;
  const refuse = async (reason: string): Promise<ConversionOutcome> => {
    // Consumed but not sent: the attempt ends REJECTED and the action goes back to needing approval.
    await updateAttemptStatus(rc, attempt.id, "REJECTED", {
      ...withoutLease(recordOf(attempt)),
      refusal: reason,
    });
    await transitionAction(rc, actionId, ["EXECUTING"], "PROPOSED", { reason });
    await appendAudit(rc, {
      actorType: "system",
      action: "conversion.refused",
      subject: actionId,
      data: { attemptId: attempt.id, reason },
    });
    log.warn(
      { actionId, attemptId: attempt.id, reason },
      "approved conversion refused; nothing sent",
    );
    return { outcome: "refused", reason, attemptId: attempt.id };
  };

  // The kill switch again, now that the attempt is written and before anything is sent.
  if (!(await executionEnabled(deps.db))) return refuse("KILL_SWITCH");

  // Re-derive the approval hash from the stored action; any difference refuses.
  const current = buildConversionSubject(stored, {
    businessId,
    approverId: approval.approverId,
    nonce: approval.nonce,
  });
  if (current === null || approvalHash(current as AnySubject) !== approval.hash) {
    return refuse("HASH_MISMATCH");
  }

  const sell = current.sellCurrency as Currency;
  const buy = current.buyCurrency as Currency;
  const sellMinor = BigInt(current.sellMinor);
  const balances = await deps.gateway.getBalances();
  const have = balances.find((b) => b.currency === sell)?.available.minor ?? 0n;
  if (have < sellMinor) return refuse("INSUFFICIENT_BALANCE");

  for (let tries = 0; tries < 2; tries++) {
    const quote = await deps.gateway.createQuote({
      buyCurrency: buy,
      sellCurrency: sell,
      sellAmount: money(sellMinor, sell),
      validity: QUOTE_VALIDITY,
    });
    if (!quote.sellAmount || !quote.buyAmount || quote.sellAmount.minor !== sellMinor) {
      return refuse("QUOTE_MISMATCH");
    }
    if (
      !rateWithinBounds(
        { sellMinor, buyMinor: quote.buyAmount.minor, sell, buy },
        current.rateLow,
        current.rateHigh,
      )
    ) {
      return refuse("RATE_OUT_OF_BOUNDS");
    }
    if (!(await claimQuote(rc, { quoteId: quote.quoteId, actionId, attemptId: attempt.id }))) {
      continue; // used before: request a fresh one
    }
    await updateAttemptStatus(rc, attempt.id, "INTENT", {
      ...withoutLease(recordOf(attempt)),
      quoteId: quote.quoteId,
      approvalId: approval.id,
      hash: approval.hash,
    });
    return sendConversion(deps, businessId, stored, attempt.id);
  }
  return refuse("QUOTE_REUSED");
}

// --- the call ----------------------------------------------------------------------------------

/**
 * Sends the attempt's conversion with the attempt's own request_id. One executor at a time (a lease on
 * the attempt). Safe to call again for the same attempt: a repeat carries the same request_id.
 */
export async function sendConversion(
  deps: ExecutorDeps,
  businessId: BusinessId,
  stored: StoredAction,
  attemptId: AttemptId,
): Promise<ConversionOutcome> {
  const log = loggerOf(deps);
  const rc = repoCtx(deps.db, businessId);
  if (stored.action.kind !== "convert") return { outcome: "skipped", reason: "NOT_A_CONVERSION" };
  const p = stored.action.params;
  const attempt = await getAttempt(rc, attemptId);
  if (attempt?.kind !== "conversion") throw new Error("conversion attempt not found");
  if (attempt.status !== "INTENT" && attempt.status !== "SENT_TO_AIRWALLEX") {
    return { outcome: "skipped", reason: `ATTEMPT_${attempt.status}` };
  }
  const claimed = await claimAttempt(
    rc,
    attemptId,
    ["INTENT", "SENT_TO_AIRWALLEX"],
    EXECUTOR_LEASE_MS,
  );
  if (!claimed) return { outcome: "skipped", reason: "HELD_BY_ANOTHER_EXECUTOR" };

  try {
    // The kill switch once more: the attempt stays INTENT (nothing sent) and resumes when it is on.
    if (!(await executionEnabled(deps.db))) {
      await releaseAttempt(rc, attemptId);
      return { outcome: "skipped", reason: "KILL_SWITCH" };
    }
    const prior = recordOf(claimed);
    if (prior.quoteId === undefined) throw new Error("attempt has no quote id");
    const sending: AttemptRecord = {
      ...prior,
      sentAt: prior.sentAt ?? nowOf(deps).toISOString(),
      sends: (prior.sends ?? 0) + 1,
    };
    // Committed before the call: a crash from here leaves SENT_TO_AIRWALLEX, and a re-run reuses the id.
    await updateAttemptStatus(rc, attemptId, "SENT_TO_AIRWALLEX", sending);
    await transitionAction(rc, stored.id, ["AUTO_APPROVED", "APPROVED", "EXECUTING"], "EXECUTING", {
      attemptId,
    });
    log.info(
      { actionId: stored.id, attemptId, requestId: attempt.requestId, sends: sending.sends },
      "sending conversion to Airwallex",
    );

    let conversion: GatewayConversion;
    try {
      conversion = await deps.gateway.createConversion({
        requestId: attempt.requestId,
        buyCurrency: p.buy_currency,
        sellCurrency: p.sell_currency,
        sellAmount: money(BigInt(p.sell_minor), p.sell_currency),
        reason: CONVERSION_REASON,
        quoteId: prior.quoteId,
      });
    } catch (error) {
      const failure = classifyFailure(error);
      if (failure.kind === "rate_limited") {
        await releaseAttempt(rc, attemptId);
        throw error; // the job retries later with the same request_id
      }
      if (failure.kind === "rejected") {
        await updateAttemptStatus(rc, attemptId, "REJECTED", {
          ...withoutLease(sending),
          error: failure.detail,
        });
        await transitionAction(rc, stored.id, ["EXECUTING", "AUTO_APPROVED"], "FAILED", {
          reason: failure.detail.code ?? "REJECTED",
        });
        await appendAudit(rc, {
          actorType: "system",
          action: "conversion.rejected",
          subject: stored.id,
          data: { attemptId, error: failure.detail },
        });
        return { outcome: "rejected", attemptId, error: failure.detail.message };
      }
      await updateAttemptStatus(rc, attemptId, "UNKNOWN", {
        ...withoutLease(sending),
        error: failure.detail,
      });
      await appendAudit(rc, {
        actorType: "system",
        action: "conversion.unknown",
        subject: stored.id,
        data: { attemptId, requestId: attempt.requestId, error: failure.detail },
      });
      log.error(
        {
          attemptId,
          requestId: attempt.requestId,
          error: failure.detail,
          alert: "attempt_unknown",
        },
        "conversion outcome unknown; the reconciler will look it up by request_id",
      );
      return { outcome: "unknown", attemptId, error: failure.detail.message };
    }
    await confirm(rc, stored.id, attemptId, withoutLease(sending), conversion, "create");
    return { outcome: "confirmed", attemptId, conversion };
  } catch (error) {
    await releaseAttempt(rc, attemptId).catch(() => undefined);
    throw error;
  }
}

async function confirm(
  rc: ReturnType<typeof repoCtx>,
  actionId: string,
  attemptId: AttemptId,
  record: AttemptRecord,
  conversion: GatewayConversion,
  how: "create" | "reconcile_lookup",
): Promise<void> {
  await updateAttemptStatus(rc, attemptId, "CONFIRMED", {
    ...record,
    conversionId: conversion.conversionId,
    status: conversion.status,
    confirmedAt: new Date().toISOString(),
    resolvedBy: how,
  } satisfies AttemptRecord);
  await transitionAction(rc, actionId, ["EXECUTING", "AUTO_APPROVED", "APPROVED"], "DONE", {
    reason: null,
  });
  await appendAudit(rc, {
    actorType: "system",
    action: "conversion.confirmed",
    subject: actionId,
    data: { attemptId, conversionId: conversion.conversionId, status: conversion.status, how },
  });
}

// --- reconciliation ----------------------------------------------------------------------------

export type ConversionResolution =
  | { resolution: "confirmed"; conversion: GatewayConversion }
  | { resolution: "rejected" }
  | { resolution: "unresolved" }
  | { resolution: "skipped"; reason: string };

/**
 * Resolves an UNKNOWN conversion attempt by looking it up by `request_id` (never by minting a new
 * one). Found -> CONFIRMED. Not found -> still UNKNOWN until `retryAfterMs` has passed since the send,
 * then the SAME request_id is sent again (Airwallex answers a repeat with the existing conversion;
 * UNVERIFIED for conversions, so the wait is deliberate). A definite 4xx then ends it REJECTED.
 */
export async function resolveConversionAttempt(
  deps: ExecutorDeps,
  input: {
    businessId: BusinessId;
    attemptId: AttemptId;
    retryAfterMs?: number;
  },
): Promise<ConversionResolution> {
  const rc = repoCtx(deps.db, input.businessId);
  const attempt = await getAttempt(rc, input.attemptId);
  if (attempt?.kind !== "conversion") return { resolution: "skipped", reason: "NOT_FOUND" };
  if (attempt.status !== "UNKNOWN") return { resolution: "skipped", reason: attempt.status };
  const found = await deps.gateway.findConversionByRequestId(attempt.requestId);
  if (found) {
    await confirm(
      rc,
      attempt.refId,
      attempt.id,
      withoutLease(recordOf(attempt)),
      found,
      "reconcile_lookup",
    );
    return { resolution: "confirmed", conversion: found };
  }
  const sentAt = recordOf(attempt).sentAt;
  const waited =
    sentAt === undefined ? Number.POSITIVE_INFINITY : nowOf(deps).getTime() - Date.parse(sentAt);
  if (waited < (input.retryAfterMs ?? DEFAULT_UNKNOWN_RETRY_AFTER_MS))
    return { resolution: "unresolved" };
  if (!(await executionEnabled(deps.db))) return { resolution: "unresolved" };
  const stored = await getStoredAction(rc, attempt.refId);
  if (!stored) return { resolution: "skipped", reason: "NO_ACTION" };
  // Back to a sendable state with the same attempt and request_id.
  await updateAttemptStatus(rc, attempt.id, "SENT_TO_AIRWALLEX", withoutLease(recordOf(attempt)));
  const sent = await sendConversion(deps, input.businessId, stored, attempt.id);
  if (sent.outcome === "confirmed") return { resolution: "confirmed", conversion: sent.conversion };
  if (sent.outcome === "unknown") return { resolution: "unresolved" };
  return { resolution: "rejected" };
}
