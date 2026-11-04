// Airwallex webhook intake, the part after verification (the route, app/api/webhooks/airwallex,
// reads the raw bytes and runs verifyWebhook first). Step 3 of ADR 0005: one transaction inserts
// webhook_events (unique provider event id; a duplicate is a no-op) and its outbox job, then 200.
// No fetch and no slow work happens here; the worker fetches the object the event names.
import { parseWebhookEvent, type WebhookEvent } from "@carnet/airwallex";
import {
  type Db,
  enqueueJob,
  insertWebhookEventIfNew,
  markWebhookEventAcked,
  withTransaction,
} from "@carnet/db";
import { apiError, type ErrorCode, httpStatusOf } from "@carnet/domain";
import { addContext } from "../../lib/request-context";
import { JOB_KIND } from "../../worker/handlers/index";
import { createLogger, type Logger } from "../log";

/** Airwallex events are a few KB; anything far larger is not one. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

let routeLogger: Logger | null = null;

/** The route's logger (pino, M1-04). Tests swap it with `setWebhookLogger` to read the lines. */
export function webhookLogger(): Logger {
  routeLogger ??= createLogger({ process: "web", route: "webhooks.airwallex" });
  return routeLogger;
}

export function setWebhookLogger(logger: Logger | null): void {
  routeLogger = logger;
}

/** Signature rejections seen by this process (logged with every rejection). */
let rejectedTotal = 0;

export interface JobForEvent {
  kind: string;
  payload: Record<string, string>;
}

/** Which job an event becomes. `payout.transfer.*` includes the funding events (same transfer). */
export function jobForEvent(event: WebhookEvent): JobForEvent | null {
  if (!event.objectId) return null;
  if (event.name.startsWith("payout.transfer.")) {
    return { kind: JOB_KIND.transferSync, payload: { transferId: event.objectId } };
  }
  if (event.name.startsWith("rfi.")) {
    return { kind: JOB_KIND.rfiSync, payload: { rfiId: event.objectId } };
  }
  return null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function error(code: ErrorCode, message: string, requestId: string): Response {
  return json(httpStatusOf(code), apiError(code, message, requestId));
}

/** Records a signature rejection: nothing is stored, the count goes on the log line. */
export function noteRejection(log: Logger, requestId: string, reason: string): void {
  rejectedTotal += 1;
  log.warn(
    { requestId, event: "webhook_rejected", reason, rejectedTotal },
    "webhook rejected: signature check failed",
  );
}

export function errorResponse(code: ErrorCode, message: string, requestId: string): Response {
  return error(code, message, requestId);
}

/**
 * Step 3, for a body whose signature already verified: parse it, then store the event and its job in
 * one transaction. Returns 200 (stored or duplicate), 400 (not an event) or 500 (store failed).
 */
export async function storeVerifiedWebhook(
  raw: Uint8Array,
  deps: { db: Db; logger: Logger; requestId: string; receivedAt?: Date },
): Promise<Response> {
  const { requestId, logger: log } = deps;
  let event: WebhookEvent;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    event = parseWebhookEvent(text);
  } catch {
    log.warn({ requestId, event: "webhook_malformed" }, "signed webhook body is not a valid event");
    return error("VALIDATION_FAILED", "webhook body is not a valid event", requestId);
  }

  // M1-09: every later line of this request, and the worker's lines for its job, carry event_id.
  addContext({ event_id: event.id });
  const job = jobForEvent(event);
  try {
    const stored = await withTransaction(deps.db, async (tx) => {
      const row = await insertWebhookEventIfNew(tx, {
        providerEventId: event.id,
        name: event.name,
        rawBody: text,
        signatureOk: true,
        ...(deps.receivedAt ? { receivedAt: deps.receivedAt } : {}),
      });
      if (!row) return null;
      const jobId = job
        ? await enqueueJob(tx, {
            kind: job.kind,
            payload: { ...job.payload, webhookEventId: row.id, providerEventId: event.id },
          })
        : null;
      // Last statement of the inbox transaction: the acknowledgement time (M1-09 ack latency).
      await markWebhookEventAcked(tx, row.id, new Date());
      return { webhookEventId: row.id, jobId };
    });
    log.info(
      {
        requestId,
        event: "webhook_received",
        providerEventId: event.id,
        name: event.name,
        duplicate: stored === null,
        jobKind: stored?.jobId ? (job?.kind ?? null) : null,
      },
      stored === null ? "duplicate webhook acknowledged" : "webhook stored",
    );
    return json(200, { received: true, duplicate: stored === null });
  } catch (cause) {
    log.error(
      {
        requestId,
        providerEventId: event.id,
        error: cause instanceof Error ? cause.message : String(cause),
      },
      "webhook could not be stored",
    );
    // A 5xx makes Airwallex redeliver (M0-05: redelivery about 0.5 s later, same event id).
    return error("INTERNAL", "webhook could not be stored", requestId);
  }
}
