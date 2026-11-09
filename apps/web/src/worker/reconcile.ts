// The reconcile job (ADR 0005, 0007): recovers what a missed or late webhook would have told us.
// 1. `GET /rfis` (TRANSACTION; ACTION_REQUIRED, ANSWERED, CLOSED) through the same ingest as webhooks
//    (M2-04), then the expiring-soon flag on RFIs near their `expires_at`.
// 2. Every payment whose transfer can still change: fetch and apply (same transfer handler).
// 3. Execution attempts in UNKNOWN: look the object up by request_id. Found -> CONFIRMED and the
//    transfer is applied to its payment. Not found -> stays UNKNOWN with an alert line; a new request
//    is never sent from here (absence from a list is not proof, BL-01 6625872848).
// Each item is isolated: one failing lookup is logged and the pass continues.
import {
  getAttempt,
  listAttemptsByStatus,
  listOpenTransfers,
  refreshRfiExpiringSoon,
  repoCtx,
  updateAttemptStatus,
} from "@carnet/db";
import { type AttemptId, type PaymentId, RFI_EXPIRING_SOON_MS } from "@carnet/domain";
import { type HandlerContext, JOB_KIND, type JobHandler } from "./handlers/index";
import { sweepStuckDrafting } from "./handlers/draft";
import { ingestRfi } from "./handlers/rfi";
import { applyFetchedTransfer, syncTransfer } from "./handlers/transfer";

export const RECONCILE_INTERVAL_MS = 60_000;
export const RECONCILE_JOB_KIND = JOB_KIND.reconcile;
const POLLED_RFI_STATUSES = ["ACTION_REQUIRED", "ANSWERED", "CLOSED"] as const;

export interface ReconcileSummary {
  rfis: number;
  /** RFIs moved from DRAFTING to NEEDS_OWNER by the timeout sweeper (M2-05). */
  draftsTimedOut: number;
  transfers: number;
  transfersApplied: number;
  attemptsConfirmed: number;
  attemptsUnresolved: number;
  errors: number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runReconcile(ctx: HandlerContext): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    rfis: 0,
    draftsTimedOut: 0,
    transfers: 0,
    transfersApplied: 0,
    attemptsConfirmed: 0,
    attemptsUnresolved: 0,
    errors: 0,
  };

  try {
    const { items } = await ctx.airwallex.listRfis({
      statuses: [...POLLED_RFI_STATUSES],
      types: ["TRANSACTION"],
    });
    for (const rfi of items) {
      await ingestRfi(ctx, rfi, "reconcile");
      summary.rfis += 1;
    }
    await refreshRfiExpiringSoon(ctx.db, new Date(), RFI_EXPIRING_SOON_MS);
  } catch (error) {
    summary.errors += 1;
    ctx.logger.warn({ step: "rfis", error: message(error) }, "reconcile: RFI poll failed");
  }

  try {
    summary.draftsTimedOut = await sweepStuckDrafting(ctx);
  } catch (error) {
    summary.errors += 1;
    ctx.logger.warn(
      { step: "drafting", error: message(error) },
      "reconcile: drafting sweep failed",
    );
  }

  for (const ref of await listOpenTransfers(ctx.db)) {
    summary.transfers += 1;
    try {
      const r = await syncTransfer(ctx, ref.transferId, ref);
      if (r.outcome === "applied") summary.transfersApplied += 1;
    } catch (error) {
      summary.errors += 1;
      ctx.logger.warn(
        { step: "transfers", transferId: ref.transferId, error: message(error) },
        "reconcile: transfer fetch failed",
      );
    }
  }

  for (const attempt of await listAttemptsByStatus(ctx.db, ["UNKNOWN"])) {
    if (attempt.kind !== "transfer") {
      // Conversions (M3-03) and RFI responses (M2-07) register their own resolvers.
      ctx.logger.warn(
        { attemptId: attempt.id, kind: attempt.kind, alert: "attempt_unresolved" },
        "reconcile: no resolver for this attempt kind yet; left UNKNOWN",
      );
      summary.attemptsUnresolved += 1;
      continue;
    }
    try {
      const transfer = await ctx.airwallex.findTransferByRequestId(attempt.requestId);
      if (!transfer) {
        ctx.logger.error(
          { attemptId: attempt.id, requestId: attempt.requestId, alert: "attempt_unresolved" },
          "reconcile: UNKNOWN attempt not found by request_id; left UNKNOWN, no new request sent",
        );
        summary.attemptsUnresolved += 1;
        continue;
      }
      const rc = repoCtx(ctx.db, attempt.businessId);
      // Keep what the sender recorded (sentAt, sends, the error that made it UNKNOWN).
      const stored = await getAttempt(rc, attempt.id as AttemptId);
      const prior =
        typeof stored?.response === "object" && stored.response !== null ? stored.response : {};
      await updateAttemptStatus(rc, attempt.id as AttemptId, "CONFIRMED", {
        ...prior,
        transferId: transfer.id,
        status: transfer.status,
        confirmedAt: new Date().toISOString(),
        resolvedBy: "reconcile_lookup",
      });
      summary.attemptsConfirmed += 1;
      ctx.logger.info(
        { attemptId: attempt.id, transferId: transfer.id },
        "reconcile: UNKNOWN attempt confirmed by lookup",
      );
      await applyFetchedTransfer(ctx, transfer, {
        businessId: attempt.businessId,
        paymentId: attempt.refId as PaymentId,
      });
    } catch (error) {
      summary.errors += 1;
      ctx.logger.warn(
        { step: "attempts", attemptId: attempt.id, error: message(error) },
        "reconcile: attempt lookup failed",
      );
    }
  }

  ctx.logger.info({ ...summary }, "reconcile pass done");
  return summary;
}

export const handleReconcile: JobHandler = async (_payload, ctx) => {
  await runReconcile(ctx);
};
