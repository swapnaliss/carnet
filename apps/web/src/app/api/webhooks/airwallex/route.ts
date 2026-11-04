// POST /api/webhooks/airwallex (ADR 0005, M0-05). Order is fixed:
//   1. read the raw bytes; nothing parses JSON before verification
//   2. verifyWebhook (M1-03): HMAC-SHA256 over `x-timestamp + rawBody`, constant time, 5-minute
//      freshness. Failure -> 401, nothing stored, counted in a log line.
//   3. one transaction: webhook_events (duplicate event id = no-op) + its outbox job -> 200
// Responses: 200 stored or duplicate · 400 signed but not an event · 401 bad signature, stale or
// malformed timestamp · 413 body over 256 KiB · 500 store failed (Airwallex redelivers) · 503 secret
// not configured.
import { verifyWebhook } from "@carnet/airwallex";
import { appDb } from "../../../../server/db";
import { createLogger } from "../../../../server/log";
import {
  errorResponse,
  MAX_WEBHOOK_BODY_BYTES,
  noteRejection,
  storeVerifiedWebhook,
} from "../../../../server/webhooks/airwallex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const logger = createLogger({ process: "web", route: "webhooks.airwallex" });

export async function POST(req: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const secret = process.env.AIRWALLEX_WEBHOOK_SECRET;
  if (!secret) {
    logger.error({ requestId }, "webhook secret is not configured (AIRWALLEX_WEBHOOK_SECRET)");
    return errorResponse("SERVICE_UNAVAILABLE", "webhook intake is not configured", requestId);
  }
  if (Number(req.headers.get("content-length") ?? "0") > MAX_WEBHOOK_BODY_BYTES) {
    return errorResponse("PAYLOAD_TOO_LARGE", "webhook body too large", requestId);
  }
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return errorResponse("PAYLOAD_TOO_LARGE", "webhook body too large", requestId);
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
}
