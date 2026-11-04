// The worker deletes expired rate-limit windows (M1-10): directly, and from the loop's housekeeping.
import { hitRateLimit } from "@carnet/db";
import { describe, expect, it } from "vitest";
import { RATE_LIMIT_RETENTION_MS } from "../../src/lib/ratelimit";
import { memoryLogger } from "../../src/server/log";
import { createRegistry } from "../../src/worker/handlers/index";
import { createWorker } from "../../src/worker/loop";
import { pruneExpiredRateLimits } from "../../src/worker/prune";
import { FetchStub, makeClient, query, webTestDatabase } from "../support";

const db = webTestDatabase();
const rule = { limit: 5, windowMs: 60_000 };
const NOW = Date.parse("2026-11-04T12:00:00.000Z");

async function windows(): Promise<string[]> {
  const rows = await query<{ w: Date }>(
    db().appUrl,
    "SELECT window_start AS w FROM rate_limits ORDER BY window_start",
  );
  return rows.map((r) => new Date(r.w).toISOString());
}

describe("rate-limit pruning", () => {
  it("deletes windows older than the retention and keeps live ones", async () => {
    await query(db().appUrl, "DELETE FROM rate_limits");
    await hitRateLimit(db().app.db, "t:old", rule, new Date(NOW - RATE_LIMIT_RETENTION_MS - 60_000));
    await hitRateLimit(db().app.db, "t:live", rule, new Date(NOW - 60_000));
    expect(await pruneExpiredRateLimits(db().app.db, NOW)).toBe(1);
    expect(await windows()).toEqual(["2026-11-04T11:59:00.000Z"]);
  });

  it("runs from the worker loop's housekeeping", async () => {
    await query(db().appUrl, "DELETE FROM rate_limits");
    await hitRateLimit(db().app.db, "t:old", rule, new Date(Date.now() - 3 * RATE_LIMIT_RETENTION_MS));
    const worker = createWorker({
      db: db().app.db,
      registry: createRegistry(),
      airwallex: makeClient(new FetchStub()),
      logger: memoryLogger(),
      reconcileEveryMs: null,
      pollMs: 10,
    });
    const running = worker.run();
    await new Promise((r) => setTimeout(r, 200));
    worker.stop();
    await running;
    expect(await windows()).toEqual([]);
  });
});
