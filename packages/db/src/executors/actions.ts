// Executing a plan, action by action (M3-03 scope 5). Each convert action has its own attempt. The loop is
// restartable: it picks actions up by state, never by memory of what ran.
//
//   DONE, FAILED, SUPERSEDED        skipped
//   EXECUTING / AUTO_APPROVED       an attempt exists: RESOLVE it (lookup by request_id), never re-send a
//                                   call that may have gone out; an attempt still UNKNOWN stops the loop,
//                                   so action N+1 never starts while action N's outcome is unresolved
//   PROPOSED                        auto-execute if the policy allows; otherwise wait for a bound approval
//                                   (an APPROVED approval of the action is executed through the same executor)
//
// Payout actions are executed by `executePayout` on their approval (they need a payment and an approver's
// hash, not a plan position), so this loop leaves them alone.
import type { AttemptId, BusinessId } from "@carnet/domain";
import { getStoredAction, listStoredActions, type StoredAction } from "../repos/action-states";
import { getLiveApprovalForSubject } from "../repos/approvals";
import { repoCtx } from "../repos/context";
import { getAttempt, updateAttemptStatus } from "../repos/execution-attempts";
import { type ExecutorDeps, recordOf, withoutLease } from "./common";
import {
  type ConversionOutcome,
  executeApprovedConversion,
  executeAutoConversion,
  resolveConversionAttempt,
  sendConversion,
} from "./conversion";

export interface ActionRunResult {
  readonly actionId: string;
  readonly seq: number;
  readonly result: string;
}

export interface RunActionsOptions {
  /** Called after each action that ran; a test throws here to simulate a crash. */
  readonly afterAction?: (result: ActionRunResult) => void | Promise<void>;
  /** Passed to the resolver: how long an UNKNOWN conversion waits before a same-id re-send. */
  readonly retryAfterMs?: number;
}

export interface RunActionsSummary {
  readonly results: ActionRunResult[];
  /** True when the loop stopped at an action whose attempt is still unresolved. */
  readonly blocked: boolean;
}

export async function runConversionActions(
  deps: ExecutorDeps,
  businessId: BusinessId,
  planId: string,
  options: RunActionsOptions = {},
): Promise<RunActionsSummary> {
  const rc = repoCtx(deps.db, businessId);
  const results: ActionRunResult[] = [];
  const actions = await listStoredActions(rc, planId);
  for (const listed of actions) {
    if (listed.action.kind !== "convert") continue;
    // Re-read: an earlier iteration (or another worker) may have moved it.
    const stored = (await getStoredAction(rc, listed.id)) ?? listed;
    if (["DONE", "FAILED", "SUPERSEDED"].includes(stored.state)) continue;

    let result: string;
    if (stored.attemptId !== null && (stored.state === "EXECUTING" || stored.state === "AUTO_APPROVED")) {
      const r = await resume(deps, businessId, stored, options);
      result = r;
      if (r === "UNRESOLVED") {
        const entry = { actionId: stored.id, seq: stored.action.seq, result };
        results.push(entry);
        await options.afterAction?.(entry);
        return { results, blocked: true };
      }
    } else {
      result = await runOne(deps, businessId, stored);
    }
    const entry = { actionId: stored.id, seq: stored.action.seq, result };
    results.push(entry);
    await options.afterAction?.(entry);
    if (result === "unknown") return { results, blocked: true };
  }
  return { results, blocked: false };
}

async function runOne(deps: ExecutorDeps, businessId: BusinessId, stored: StoredAction): Promise<string> {
  const rc = repoCtx(deps.db, businessId);
  // An owner-approved conversion goes through the same executor after the approval is consumed.
  const live = await getLiveApprovalForSubject(rc, "conversion", stored.id);
  if (live !== null && live.status === "APPROVED") {
    return label(await executeApprovedConversion(deps, businessId, { approvalId: live.id, expectedHash: live.hash }));
  }
  return label(await executeAutoConversion(deps, businessId, stored.id));
}

async function resume(
  deps: ExecutorDeps,
  businessId: BusinessId,
  stored: StoredAction,
  options: RunActionsOptions,
): Promise<string> {
  const rc = repoCtx(deps.db, businessId);
  const attemptId = stored.attemptId as AttemptId;
  const attempt = await getAttempt(rc, attemptId);
  if (!attempt) return "UNRESOLVED";
  if (attempt.status === "INTENT") {
    // Written, never sent: send it now with the same request_id.
    return label(await sendConversion(deps, businessId, stored, attemptId));
  }
  if (attempt.status === "SENT_TO_AIRWALLEX") {
    // The call may have gone out before the crash. Treat it as UNKNOWN: look it up, do not re-send blindly.
    await updateAttemptStatus(rc, attemptId, "UNKNOWN", {
      ...withoutLease(recordOf(attempt)),
      resolvedBy: "crash_recovery",
    });
  }
  const latest = await getAttempt(rc, attemptId);
  if (latest && (latest.status === "UNKNOWN" || attempt.status === "SENT_TO_AIRWALLEX")) {
    const r = await resolveConversionAttempt(deps, {
      businessId,
      attemptId,
      ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    });
    return r.resolution === "unresolved" ? "UNRESOLVED" : `resolved_${r.resolution}`;
  }
  return `attempt_${latest?.status ?? "missing"}`;
}

function label(outcome: ConversionOutcome): string {
  switch (outcome.outcome) {
    case "skipped":
      return `skipped_${outcome.reason}`;
    case "denied":
      return `denied_${outcome.reason}`;
    case "refused":
      return `refused_${outcome.reason}`;
    default:
      return outcome.outcome;
  }
}
