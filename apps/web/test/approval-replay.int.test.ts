// M2-07 AC 2 (replay): the same approval consumed twice in sequence, and by 20 concurrent executors, is
// one CONSUMED row, one attempt, one upload and one respond call on the fixture transport.
import { listAttemptsForRefs } from "@carnet/db";
import type { ApprovalId } from "@carnet/domain";
import { afterAll, describe, expect, it } from "vitest";
import { runRfiRespond } from "../src/worker/handlers/rfi-respond";
import { approved, setupApprovable } from "./approval-support";
import { blockedCalls, query, webTestDatabase } from "./support";

const db = webTestDatabase();
afterAll(() => expect(blockedCalls).toEqual([]));

describe("replay", () => {
  it("20 concurrent executors for one approval: exactly one CONSUMED row, one attempt, one respond", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    const input = { businessId: a.businessId, approvalId: ap.id as ApprovalId, hash: ap.hash };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => runRfiRespond(a.ctx, input)),
    );

    expect(results.filter((r) => r.outcome === "confirmed")).toHaveLength(1);
    expect(a.responds()).toHaveLength(1);
    expect(a.uploads()).toHaveLength(1);
    expect(await listAttemptsForRefs(a.repo, "respond", [a.rfi.id])).toHaveLength(1);
    const rows = await query<{ status: string }>(
      db().appUrl,
      "SELECT status FROM approvals WHERE business_id = $1",
      [a.businessId],
    );
    expect(rows).toEqual([{ status: "CONSUMED" }]);
    // Everyone else was refused or found the work done; none sent anything.
    for (const r of results) {
      expect(["confirmed", "consume_refused", "skipped"]).toContain(r.outcome);
    }
  });

  it("a stale job carrying a different hash consumes nothing", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    const result = await runRfiRespond(a.ctx, {
      businessId: a.businessId,
      approvalId: ap.id as ApprovalId,
      hash: "e".repeat(64),
    });
    expect(result).toEqual({ outcome: "consume_refused", reason: "HASH_MISMATCH" });
    expect(a.responds()).toEqual([]);
    expect(await listAttemptsForRefs(a.repo, "respond", [a.rfi.id])).toEqual([]);
  });
});
