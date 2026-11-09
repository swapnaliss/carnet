// Route rate limits (ADR 0004, ADR 0012, M1-10). One limiter: the database counter in @carnet/db
// (`hitRateLimit`, an atomic upsert on rate_limits(key, window_start, count), fixed windows aligned
// to the epoch). This module holds the rules, the key format and the client-IP rule.
//
// Key format: `<route>:<subject kind>:<subject>`, e.g. `approval:user:<uuid>`, `webhook:ip:203.0.113.9`,
// `login:email:<sha256 of the lower-cased email>`.
//
// Rules (per fixed window):
//   login     5 failed sign-ins per email and 20 per IP, per 15 minutes (only failures count)
//   approval  20 per minute per user (registered for M2-07; a route opts in with `rateLimit`)
//   webhook   RATE_LIMIT_WEBHOOK_PER_MIN (default 600) per minute per source IP
//   upload    UPLOAD_SESSION_MAX_FILES (default 10) files and UPLOAD_SESSION_MAX_BYTES (default 25 MiB)
//             per session per hour (M2-01, src/server/documents/limits.ts)
//   payee_status  PAYEE_STATUS_RATE_LIMIT_PER_MIN (default 30) per minute per IP, and per live link
//             (token-hash prefix); counted directly in server/payee-status.ts (M3-06)
// Expired windows are deleted by the worker (src/worker/prune.ts).
import { createHash } from "node:crypto";
import { type Db, hitRateLimit, type RateLimitRule, type RateLimitState } from "@carnet/db";

export type { RateLimitRule, RateLimitState };

const MINUTE = 60_000;

export const LOGIN_RATE_LIMITS = {
  email: { limit: 5, windowMs: 15 * MINUTE },
  ip: { limit: 20, windowMs: 15 * MINUTE },
} as const satisfies Record<string, RateLimitRule>;

export const APPROVAL_RATE_LIMIT = { limit: 20, windowMs: MINUTE } as const satisfies RateLimitRule;

export const DEFAULT_WEBHOOK_PER_MIN = 600;

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** The webhook rule, read from the environment on each call (RATE_LIMIT_WEBHOOK_PER_MIN). */
export function webhookRateLimit(env: Record<string, string | undefined> = process.env) {
  return {
    limit: positiveInt(env.RATE_LIMIT_WEBHOOK_PER_MIN, DEFAULT_WEBHOOK_PER_MIN),
    windowMs: MINUTE,
  } satisfies RateLimitRule;
}

/** The named rules a `defineRoute` route can opt into. */
export const ROUTE_RATE_LIMITS = {
  approval: () => APPROVAL_RATE_LIMIT,
  webhook: () => webhookRateLimit(),
} as const satisfies Record<string, () => RateLimitRule>;

export type RouteRateLimitName = keyof typeof ROUTE_RATE_LIMITS;

/** Windows older than this are pruned; longer than the longest window (15 minutes). */
export const RATE_LIMIT_RETENTION_MS = 60 * MINUTE;

export type SubjectKind = "user" | "email" | "ip" | "session" | "token";

export function rateLimitKey(route: string, kind: SubjectKind, subject: string): string {
  return `${route}:${kind}:${subject}`;
}

/** Proxies in front of the app that append to `x-forwarded-for` (TRUSTED_PROXY_HOPS, default 1). */
export function trustedProxyHops(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.TRUSTED_PROXY_HOPS ?? "1");
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

/**
 * The caller's IP for per-IP counters. A client can write any `x-forwarded-for` it likes; each
 * trusted proxy appends the address it received the request from. So the trustworthy entry is the
 * one the outermost trusted proxy appended: `hops` entries from the right. Entries to its left are
 * client-supplied and ignored. With `hops = 0` (no proxy) the header is ignored entirely.
 * When the header is shorter than `hops` (the request skipped a proxy), its leftmost entry is used.
 * Falls back to `x-real-ip`, then "unknown". The hop count for the hosting platform is set in its
 * environment and verified on the first deploy (M1-06).
 */
export function clientIp(req: Request, hops: number = trustedProxyHops()): string {
  const chain = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hops > 0 && chain.length > 0) {
    return chain[Math.max(0, chain.length - hops)] ?? "unknown";
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** `rate_limits.key` values for a login attempt. The email is lower-cased and hashed. */
export function loginRateLimitKeys(email: string, ip: string): { email: string; ip: string } {
  const digest = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  return { email: rateLimitKey("login", "email", digest), ip: rateLimitKey("login", "ip", ip) };
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the window ends; the `retry-after` header on a 429. */
  readonly retryAfter: number;
}

/** Counts one request against `key` and decides on it (atomic; see @carnet/db `hitRateLimit`). */
export async function consumeRateLimit(
  db: Db,
  key: string,
  rule: RateLimitRule,
  now: Date = new Date(),
): Promise<RateLimitDecision> {
  const s = await hitRateLimit(db, key, rule, now);
  return { allowed: s.allowed, remaining: s.remaining, retryAfter: s.retryAfterSeconds };
}
