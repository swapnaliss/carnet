// POST /api/webhooks/airwallex (ADR 0005, M0-05). Declared with `defineRawRoute` (M1-10), the
// raw-body variant: the HMAC is over the exact bytes, so nothing parses the body before verification.
// Order is fixed:
//   0. rate limit per source IP (RATE_LIMIT_WEBHOOK_PER_MIN, default 600 a minute) -> 429, so a
//      retry storm cannot exhaust the database; then the body cap (256 KiB) -> 413
//   1. read the raw bytes; nothing parses JSON before verification
//   2. verifyWebhook (M1-03): HMAC-SHA256 over `x-timestamp + rawBody`, constant time, 5-minute
//      freshness. Failure -> 401, nothing stored, counted in a log line.
//   3. one transaction: webhook_events (duplicate event id = no-op) + its outbox job -> 200
// Responses: 200 stored or duplicate · 400 signed but not an event · 401 bad signature, stale or
// malformed timestamp · 413 body over 256 KiB · 429 rate limited · 500 store failed (Airwallex
// redelivers) · 503 secret not configured.
import { verifyWebhook } from "@carnet/airwallex";
import { defineRawRoute } from "../../../../lib/define-route";
import { appDb } from "../../../../server/db";
import {
  errorResponse,
  MAX_WEBHOOK_BODY_BYTES,
  noteRejection,
  storeVerifiedWebhook,
  webhookLogger,
} from "../../../../server/webhooks/airwallex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = defineRawRoute({
  method: "POST",
  maxBodyBytes: MAX_WEBHOOK_BODY_BYTES,
  rateLimit: { name: "webhook", by: "ip" },
  handler: async ({ req, raw, requestId }) => {
    const logger = webhookLogger();
    const secret = process.env.AIRWALLEX_WEBHOOK_SECRET;
    if (!secret) {
      logger.error({ requestId }, "webhook secret is not configured (AIRWALLEX_WEBHOOK_SECRET)");
      return errorResponse("SERVICE_UNAVAILABLE", "webhook intake is not configured", requestId);
    }

    const verdict = verifyWebhook({
      rawBody: raw,
      timestamp: req.headers.get("x-timestamp"),
      signature: req.headers.get("x-signature"),
      secret,
      now: Date.now(),
    });
    if (!verdict.ok) {
      noteRejection(logger, requestId, verdict.reason);
      return errorResponse("UNAUTHENTICATED", "invalid webhook signature", requestId);
    }

    return storeVerifiedWebhook(raw, { db: appDb().db, logger, requestId });
  },
});
