// Worker housekeeping (M1-10): deletes rate-limit windows that ended long ago, so `rate_limits`
// holds only live counters. Run from the loop every PRUNE_INTERVAL_MS; idempotent and cheap.
import { type Db, pruneRateLimits } from "@carnet/db";
import { RATE_LIMIT_RETENTION_MS } from "../lib/ratelimit";

export const PRUNE_INTERVAL_MS = 10 * 60_000;

/** Deletes windows that started more than RATE_LIMIT_RETENTION_MS before `now`. */
export async function pruneExpiredRateLimits(db: Db, now: number = Date.now()): Promise<number> {
  return pruneRateLimits(db, new Date(now - RATE_LIMIT_RETENTION_MS));
}
