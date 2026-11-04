// Webhook signature verification (M0-05, docs/evidence/airwallex-webhooks.md):
//   x-signature = hex(HMAC_SHA256(secret, x-timestamp + rawBody)), x-timestamp in epoch milliseconds.
// Verify over the raw bytes before any JSON parsing, compare in constant time, and reject a timestamp
// more than 5 minutes old or more than 1 minute in the future. A malformed signature takes the same
// path as a wrong one (an HMAC is still computed and compared), so it is not timing-distinguishable.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;
export const WEBHOOK_MAX_FUTURE_MS = 60 * 1000;

export type WebhookRejection = "malformed_timestamp" | "stale" | "future" | "bad_signature";

export type WebhookVerdict = { ok: true } | { ok: false; reason: WebhookRejection };

export interface VerifyWebhookInput {
  /** The request body exactly as received (bytes or the undecoded string). */
  rawBody: Uint8Array | string;
  /** The `x-timestamp` header (epoch milliseconds, as a string). */
  timestamp: string | null | undefined;
  /** The `x-signature` header (64 lowercase hex characters). */
  signature: string | null | undefined;
  secret: string;
  /** Receipt time in epoch milliseconds. */
  now: number;
}

const HEX64 = /^[0-9a-f]{64}$/i;

export function computeWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: Uint8Array | string,
): string {
  return createHmac("sha256", secret).update(timestamp).update(rawBody).digest("hex");
}

export function verifyWebhook(input: VerifyWebhookInput): WebhookVerdict {
  const ts = input.timestamp ?? "";
  const expected = Buffer.from(computeWebhookSignature(input.secret, ts, input.rawBody), "hex");
  const sig = input.signature ?? "";
  // A malformed value is replaced by zeros of the right length and still compared, so the time taken
  // does not reveal whether the input was well-formed.
  const wellFormed = HEX64.test(sig);
  const given = wellFormed ? Buffer.from(sig, "hex") : Buffer.alloc(expected.length);
  const match = timingSafeEqual(given, expected) && wellFormed;

  if (!/^\d{1,16}$/.test(ts)) return { ok: false, reason: "malformed_timestamp" };
  if (!match) return { ok: false, reason: "bad_signature" };
  const age = input.now - Number(ts);
  if (age > WEBHOOK_MAX_AGE_MS) return { ok: false, reason: "stale" };
  if (age < -WEBHOOK_MAX_FUTURE_MS) return { ok: false, reason: "future" };
  return { ok: true };
}

export interface WebhookEvent {
  id: string;
  name: string;
  accountId: string | null;
  /** `rfi.*`: `{id, type}` only, so fetch the RFI. `payout.transfer.*`: the transfer object. */
  data: Record<string, unknown>;
  objectId: string | null;
  createdAt: string | null;
  version: string | null;
}

const EventWire = z
  .looseObject({
    id: z.string().min(1),
    name: z.string().min(1),
    account_id: z.string().nullish(),
    data: z.record(z.string(), z.unknown()),
    created_at: z.string().nullish(),
    version: z.string().nullish(),
  })
  .transform(
    (w): WebhookEvent => ({
      id: w.id,
      name: w.name,
      accountId: w.account_id ?? null,
      data: w.data,
      objectId: typeof w.data.id === "string" ? w.data.id : null,
      createdAt: w.created_at ?? null,
      version: w.version ?? null,
    }),
  );

/** Parses a verified body. Call only after `verifyWebhook` returned ok. Never trust `data.status`. */
export function parseWebhookEvent(rawBody: Uint8Array | string): WebhookEvent {
  const text = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8");
  return EventWire.parse(JSON.parse(text));
}
