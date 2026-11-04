// `rfi.sync`: a placeholder until M2-04 lands the `rfis` table and its ingest handler, which it
// registers under the same job kind (`registerHandler(registry, JOB_KIND.rfiSync, …)`). It fetches
// the RFI (the webhook carries only `{id, type}`) and logs a minimal record. It never reads or writes
// a payment: an RFI never changes a payment's money status.
import type { Rfi } from "@carnet/airwallex";
import { markWebhookEventProcessed } from "@carnet/db";
import {
  type HandlerContext,
  type JobHandler,
  payloadOptionalString,
  payloadString,
} from "./index";

export function recordRfi(ctx: HandlerContext, rfi: Rfi, source: "webhook" | "reconcile"): void {
  ctx.logger.info(
    {
      rfiId: rfi.id,
      rfiType: rfi.type,
      rfiStatus: rfi.status,
      rfiUpdatedAt: rfi.updatedAt,
      activeQuestions: rfi.activeRequest?.questions.length ?? 0,
      source,
    },
    "rfi fetched (placeholder handler until M2-04)",
  );
}

/** Payload: `{ rfiId, webhookEventId? }`. */
export const handleRfiSync: JobHandler = async (payload, ctx) => {
  const rfiId = payloadString(payload, "rfiId");
  const rfi = await ctx.airwallex.getRfi(rfiId);
  recordRfi(ctx, rfi, "webhook");
  const eventId = payloadOptionalString(payload, "webhookEventId");
  if (eventId) await markWebhookEventProcessed(ctx.db, eventId);
};
