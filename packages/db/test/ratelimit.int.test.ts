// The one fixed-window limiter over rate_limits (M1-04, consolidated in M1-10: repos/rate-limits).
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  hitRateLimit,
  peekRateLimit,
  pruneRateLimits,
  refundRateLimit,
  windowStartOf,
} from "../src/index";
import { rateLimits } from "../src/schema/index";
import { useTestDatabase } from "./harness";

const db = useTestDatabase();
const rule = { limit: 3, windowMs: 60_000 };

describe("rate limiter", () => {
  it("aligns windows to the epoch", () => {
    expect(windowStartOf(new Date("2026-11-04T10:07:31.500Z"), 15 * 60_000).toISOString()).toBe(
      "2026-11-04T10:00:00.000Z",
    );
    expect(() => windowStartOf(new Date(), 0)).toThrow(RangeError);
  });

  it("peek reads without counting; hit counts; limited after `limit` hits", async () => {
    const now = new Date("2026-11-04T10:00:15.000Z");
    const key = "test:peek-hit";
    expect(await peekRateLimit(db().app.db, key, rule, now)).toMatchObject({
      count: 0,
      limited: false,
    });
    for (let i = 1; i <= 3; i++) {
      const s = await hitRateLimit(db().app.db, key, rule, now);
      expect(s).toMatchObject({ count: i, limited: false });
    }
    const peek = await peekRateLimit(db().app.db, key, rule, now);
    expect(peek).toMatchObject({ count: 3, limited: true, retryAfterSeconds: 45 });
    expect(await hitRateLimit(db().app.db, key, rule, now)).toMatchObject({
      count: 4,
      limited: true,
    });

    // The next window starts again from zero.
    const later = new Date(now.getTime() + 60_000);
    expect(await peekRateLimit(db().app.db, key, rule, later)).toMatchObject({ limited: false });
  });

  it("concurrent hits lose no count (atomic upsert-increment)", async () => {
    const now = new Date("2026-11-04T11:00:00.000Z");
    const key = "test:concurrent";
    await Promise.all(Array.from({ length: 25 }, () => hitRateLimit(db().app.db, key, rule, now)));
    const [row] = await db()
      .app.db.select({ count: rateLimits.count })
      .from(rateLimits)
      .where(and(eq(rateLimits.key, key), eq(rateLimits.windowStart, windowStartOf(now, 60_000))));
    expect(row?.count).toBe(25);
  });

  it("of 50 concurrent hits exactly `limit` are allowed, with `remaining` counting down", async () => {
    const now = new Date("2026-11-04T12:00:00.000Z");
    const results = await Promise.all(
      Array.from({ length: 50 }, () => hitRateLimit(db().app.db, "test:burst", rule, now)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(results.filter((r) => r.limited)).toHaveLength(47);
    expect(results.every((r) => r.allowed === !r.limited)).toBe(true);
    expect(results.filter((r) => r.allowed).map((r) => r.remaining).sort()).toEqual([0, 1, 2]);
    expect(results.filter((r) => r.limited).every((r) => r.remaining === 0)).toBe(true);
  });

  it("refund takes back one hit in the same window and never goes below zero", async () => {
    const now = new Date("2026-11-04T13:00:00.000Z");
    const key = "test:refund";
    await hitRateLimit(db().app.db, key, rule, now);
    await refundRateLimit(db().app.db, key, rule, now);
    await refundRateLimit(db().app.db, key, rule, now);
    expect(await peekRateLimit(db().app.db, key, rule, now)).toMatchObject({ count: 0 });
    // A refund with no row is a no-op.
    await refundRateLimit(db().app.db, "test:refund-none", rule, now);
  });

  it("prune deletes only windows that started before the cut-off", async () => {
    const old = new Date("2026-11-04T08:00:00.000Z");
    const recent = new Date("2026-11-04T09:59:00.000Z");
    await hitRateLimit(db().app.db, "test:prune", rule, old);
    await hitRateLimit(db().app.db, "test:prune", rule, recent);
    const removed = await pruneRateLimits(db().app.db, new Date("2026-11-04T09:00:00.000Z"));
    expect(removed).toBeGreaterThanOrEqual(1);
    const rows = await db()
      .app.db.select({ windowStart: rateLimits.windowStart })
      .from(rateLimits)
      .where(eq(rateLimits.key, "test:prune"));
    expect(rows.map((r) => r.windowStart.toISOString())).toEqual(["2026-11-04T09:59:00.000Z"]);
  });
});
