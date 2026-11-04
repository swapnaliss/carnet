// Generic fixed-window rate limiter over the `rate_limits` table (ADR 0012). The counter is a row
// keyed by (key, window_start); `hit` is the atomic upsert-increment `incrementRateLimit`, so
// concurrent callers never lose a count. M1-04 wires login; M1-10 owns hardening this API and
// reuses it for the approval and webhook routes.
import { and, eq } from "drizzle-orm";
import type { Db } from "./client";
import { incrementRateLimit } from "./repos/system";
import { rateLimits } from "./schema/index";

export interface RateLimitRule {
  /** Requests allowed per window; the next one is limited. */
  readonly limit: number;
  /** Window length in milliseconds (fixed windows aligned to the epoch). */
  readonly windowMs: number;
}

export interface RateLimitState {
  readonly key: string;
  readonly windowStart: Date;
  /** Hits recorded in the current window. */
  readonly count: number;
  /** True when the caller must be refused (429). */
  readonly limited: boolean;
  /** Whole seconds until the window ends (at least 1); the `retry-after` value. */
  readonly retryAfterSeconds: number;
}

export function windowStartOf(now: Date, windowMs: number): Date {
  if (!Number.isInteger(windowMs) || windowMs <= 0) throw new RangeError("windowMs must be > 0");
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

function state(key: string, rule: RateLimitRule, now: Date, count: number, limited: boolean) {
  const windowStart = windowStartOf(now, rule.windowMs);
  const msLeft = windowStart.getTime() + rule.windowMs - now.getTime();
  return {
    key,
    windowStart,
    count,
    limited,
    retryAfterSeconds: Math.max(1, Math.ceil(msLeft / 1000)),
  } satisfies RateLimitState;
}

/** Reads the current window without counting: limited once `limit` hits are recorded. */
export async function peekRateLimit(
  db: Db,
  key: string,
  rule: RateLimitRule,
  now: Date = new Date(),
): Promise<RateLimitState> {
  const windowStart = windowStartOf(now, rule.windowMs);
  const [row] = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(and(eq(rateLimits.key, key), eq(rateLimits.windowStart, windowStart)));
  const count = row?.count ?? 0;
  return state(key, rule, now, count, count >= rule.limit);
}

/** Records one hit (atomic upsert-increment): limited when this hit is past `limit`. */
export async function hitRateLimit(
  db: Db,
  key: string,
  rule: RateLimitRule,
  now: Date = new Date(),
): Promise<RateLimitState> {
  const count = await incrementRateLimit(db, key, windowStartOf(now, rule.windowMs));
  return state(key, rule, now, count, count > rule.limit);
}
