// M2-07 AC 6 (kill switch): with execution_enabled=false nothing is consumed or sent and pending
// approvals read EXPIRED (KILL_SWITCH); an attempt already past INTENT still resolves.
import {
  getApproval,
  getAttempt,
  getRfi,
  listAttemptsForRefs,
  repoCtx,
  updateAttemptStatus,
} from "@carnet/db";
import type { ApprovalId, AttemptId } from "@carnet/domain";
import { afterAll, describe, expect, it } from "vitest";
import { hangUntilAborted } from "../../../packages/airwallex/test/fixture-loader";
import { sweepApprovals } from "../src/worker/approval-sweep";
import { respondRecord, runRfiRespond } from "../src/worker/handlers/rfi-respond";
import { runReconcile } from "../src/worker/reconcile";
import { type Approvable, approved, setupApprovable } from "./approval-support";
import { fixtureRfi, retarget } from "./rfi-support";
import { blockedCalls, query, webTestDatabase } from "./support";

const db = webTestDatabase();
afterAll(() => expect(blockedCalls).toEqual([]));

async function setFlag(enabled: boolean): Promise<void> {
  await query(db().migrationUrl, "UPDATE system_flags SET execution_enabled = $1 WHERE id = 1", [
    enabled,
  ]);
}

const input = (a: Approvable, ap: { id: string; hash: string }) => ({
  businessId: a.businessId,
  approvalId: ap.id as ApprovalId,
  hash: ap.hash,
});

describe("kill switch off", () => {
  it("nothing is consumed or sent; the approval reads EXPIRED (KILL_SWITCH); the draft returns to the owner", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    await setFlag(false);
    try {
      const out = await runRfiRespond(a.ctx, input(a, ap));
      expect(out).toEqual({ outcome: "consume_refused", reason: "KILL_SWITCH" });
      const approval = await getApproval(a.repo, ap.id as ApprovalId);
      expect(approval?.status).toBe("EXPIRED");
      expect(approval?.endReason).toBe("KILL_SWITCH");
      expect(await listAttemptsForRefs(a.repo, "respond", [a.rfi.id])).toEqual([]);
      expect(a.uploads()).toHaveLength(0);
      expect(a.responds()).toHaveLength(0);
      expect((await getRfi(a.repo, a.rfi.id))?.state).toBe("DRAFT_READY");
    } finally {
      await setFlag(true);
    }
  });

  it("the sweep expires a pending approval before any executor runs", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    await setFlag(false);
    try {
      const swept = await sweepApprovals(a.ctx);
      expect(swept.killSwitchExpired).toBeGreaterThanOrEqual(1);
      expect((await getApproval(a.repo, ap.id as ApprovalId))?.status).toBe("EXPIRED");
      expect((await getRfi(a.repo, a.rfi.id))?.state).toBe("DRAFT_READY");
    } finally {
      await setFlag(true);
    }
  });
});

describe("an attempt already past INTENT still resolves with the switch off", () => {
  it("SENT_TO_AIRWALLEX: a re-run of the job continues it to CONFIRMED", async () => {
    const a = await setupApprovable(db().app.db, { client: { timeoutMs: 20, maxAttempts: 1 } });
    a.stub.on("POST", /\/respond$/, (_c, init) => hangUntilAborted(init));
    const ap = await approved(a);
    expect((await runRfiRespond(a.ctx, input(a, ap))).outcome).toBe("unknown");
    const [attempt] = await listAttemptsForRefs(a.repo, "respond", [a.rfi.id]);
    // The process died after the call was committed as sent: SENT_TO_AIRWALLEX, then the lease expired.
    const rc = repoCtx(a.db, a.businessId);
    await updateAttemptStatus(
      rc,
      attempt?.id as AttemptId,
      "SENT_TO_AIRWALLEX",
      respondRecord(attempt as never),
    );
    a.stub.on("POST", /\/respond$/, (call) => {
      const answered = retarget(fixtureRfi("rfi-check2-respond-full"), {
        id: call.path.split("/")[4] ?? "",
      });
      a.current.set(a.airwallexRfiId, answered);
      return Response.json(answered);
    });
    await setFlag(false);
    try {
      const out = await runRfiRespond(a.ctx, input(a, ap));
      expect(out.outcome).toBe("confirmed");
      expect((await getAttempt(a.repo, attempt?.id as AttemptId))?.status).toBe("CONFIRMED");
    } finally {
      await setFlag(true);
    }
  });

  it("UNKNOWN: reconcile looks the RFI up and confirms it", async () => {
    const a = await setupApprovable(db().app.db, { client: { timeoutMs: 20, maxAttempts: 1 } });
    a.stub.on("POST", /\/respond$/, (_c, init) => hangUntilAborted(init));
    const ap = await approved(a);
    expect((await runRfiRespond(a.ctx, input(a, ap))).outcome).toBe("unknown");
    a.current.set(
      a.airwallexRfiId,
      retarget(fixtureRfi("rfi-check2-fetch-after-full"), { id: a.airwallexRfiId }),
    );
    await setFlag(false);
    try {
      await runReconcile(a.ctx);
      const [attempt] = await listAttemptsForRefs(a.repo, "respond", [a.rfi.id]);
      expect(attempt?.status).toBe("CONFIRMED");
      expect(a.responds()).toHaveLength(1);
    } finally {
      await setFlag(true);
    }
  });
});
