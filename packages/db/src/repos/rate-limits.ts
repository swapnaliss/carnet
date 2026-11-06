// The one rate limiter (ADR 0004, ADR 0012, M1-10): fixed windows over `rate_limits(key,
// window_start, count)`, aligned to the epoch. Every count is one atomic upsert-increment, so
// concurrent callers never lose a hit and never get more than `limit` allowed in a window.
// Keys name the route and the subject: `<route>:<subject kind>:<subject>` (apps/web lib/ratelimit).
// The worker deletes windows that ended long ago (`pruneRateLimits`).
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../client";
import { rateLimits } from "../schema/index";

export interface RateLimitRule {
  /** Requests allowed per window; the next one is refused. */
  readonly limit: number;
  /** Window length in milliseconds (fixed windows aligned to the epoch). */
  readonly windowMs: number;
}

export interface RateLimitState {
  readonly key: string;
  readonly windowStart: Date;
  /** Hits recorded in the current window (including refused ones). */
  readonly count: number;
  /** True when the caller may proceed. */
  readonly allowed: boolean;
  /** True when the caller must be refused (429); always `!allowed`. */
  readonly limited: boolean;
  /** Hits still allowed in this window after this one (0 when limited). */
  readonly remaining: number;
  /** Whole seconds until the window ends (at least 1); the `retry-after` value. */
  readonly retryAfterSeconds: number;
}

export function windowStartOf(now: Date, windowMs: number): Date {
  if (!Number.isInteger(windowMs) || windowMs <= 0) throw new RangeError("windowMs must be > 0");
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

function assertRule(rule: RateLimitRule): void {
  if (!Number.isInteger(rule.limit) || rule.limit < 1) throw new RangeError("limit must be >= 1");
}

function state(key: string, rule: RateLimitRule, now: Date, count: number, allowed: boolean) {
  const windowStart = windowStartOf(now, rule.windowMs);
  const msLeft = windowStart.getTime() + rule.windowMs - now.getTime();
  return {
    key,
    windowStart,
    count,
    allowed,
    limited: !allowed,
    remaining: allowed ? Math.max(0, rule.limit - count) : 0,
    retryAfterSeconds: Math.max(1, Math.ceil(msLeft / 1000)),
  } satisfies RateLimitState;
}

function assertAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount < 1) throw new RangeError("amount must be >= 1");
}

/**
 * Atomically adds `amount` (default one hit) to the (key, window) bucket and returns the new count.
 * An amount above one counts a quantity such as bytes (M2-01 upload byte cap).
 */
export async function incrementRateLimit(
  db: Db,
  key: string,
  windowStart: Date,
  amount = 1,
): Promise<number> {
  assertAmount(amount);
  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart, count: amount })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + ${amount}` },
    })
    .returning({ count: rateLimits.count });
  if (!row) throw new Error("upsert returned no row");
  return row.count;
}

/** Reads the current window without counting: refused once `limit` hits are recorded. */
export async function peekRateLimit(
  db: Db,
  key: string,
  rule: RateLimitRule,
  now: Date = new Date(),
): Promise<RateLimitState> {
  assertRule(rule);
  const windowStart = windowStartOf(now, rule.windowMs);
  const [row] = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(and(eq(rateLimits.key, key), eq(rateLimits.windowStart, windowStart)));
  const count = row?.count ?? 0;
  return state(key, rule, now, count, count < rule.limit);
}

/**
 * Records one hit (atomic upsert-increment) and decides on it: allowed while the new count is at most
 * `limit`. Of any number of concurrent calls in one window, exactly `limit` are allowed. With
 * `amount` it records that many units at once (bytes), allowed while the new total is at most `limit`.
 */
export async function hitRateLimit(
  db: Db,
  key: string,
  rule: RateLimitRule,
  now: Date = new Date(),
  amount = 1,
): Promise<RateLimitState> {
  assertRule(rule);
  const count = await incrementRateLimit(db, key, windowStartOf(now, rule.windowMs), amount);
  return state(key, rule, now, count, count <= rule.limit);
}

/**
 * Takes back one hit recorded by `hitRateLimit` in the same window (never below zero). For limits
 * that count only failures: hit first, refund when the attempt succeeded.
 */
export async function refundRateLimit(
  db: Db,
  key: string,
  rule: RateLimitRule,
  now: Date = new Date(),
  amount = 1,
): Promise<void> {
  assertAmount(amount);
  const windowStart = windowStartOf(now, rule.windowMs);
  await db
    .update(rateLimits)
    .set({ count: sql`greatest(${rateLimits.count} - ${amount}, 0)` })
    .where(and(eq(rateLimits.key, key), eq(rateLimits.windowStart, windowStart)));
}

/** Deletes every window that started before `before`; returns how many rows went. */
export async function pruneRateLimits(db: Db, before: Date): Promise<number> {
  const rows = await db
    .delete(rateLimits)
    .where(lt(rateLimits.windowStart, before))
    .returning({ key: rateLimits.key });
  return rows.length;
}
