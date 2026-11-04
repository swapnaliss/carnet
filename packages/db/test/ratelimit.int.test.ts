// The generic fixed-window limiter over rate_limits (M1-04; M1-10 reuses it).
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { hitRateLimit, peekRateLimit, windowStartOf } from "../src/index";
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
});
