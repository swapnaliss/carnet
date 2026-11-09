// M2-07: the approvals table, the atomic consume and its transaction with the ExecutionAttempt.
// AC: replay (sequential and 20 concurrent consumers give one CONSUMED row and one attempt); the consume
// and the attempt insert are one transaction; an expired approval cannot be consumed; the bound content
// cannot change; the kill switch refuses and expires pending approvals.
import {
  type ApprovalId,
  type BusinessId,
  newRequestId,
  type RfiId,
  type UserId,
} from "@carnet/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { DuplicateRequestIdError } from "../src/errors";
import * as repos from "../src/repos/index";
import { sqlStateOf, useTestDatabase, withClient } from "./harness";

const db = useTestDatabase({ prefix: "approvals" });

let biz: BusinessId;
let user: UserId;
const ctx = () => repos.repoCtx(db().app.db, biz);
const HASH = "a".repeat(64);

async function approval(over: Partial<repos.NewApproval> = {}): Promise<repos.Approval> {
  const rfiId = (over.subjectRef ?? crypto.randomUUID()) as RfiId;
  return repos.createApproval(ctx(), {
    kind: "rfi_answer",
    subjectRef: rfiId,
    hash: HASH,
    nonce: crypto.randomUUID(),
    approverId: user,
    expiresAt: new Date(Date.now() + 30 * 60_000),
    shownSnapshot: { answer: "exactly what was shown" },
    ...over,
  });
}

async function setFlag(enabled: boolean): Promise<void> {
  await withClient(db().migrationUrl, (c) =>
    c.query("UPDATE system_flags SET execution_enabled = $1 WHERE id = 1", [enabled]),
  );
}

beforeAll(async () => {
  biz = await repos.createBusiness(db().app.db, { name: "Approvals Co" });
  user = (await repos.createUser(ctx(), { email: "owner@approvals.test", role: "owner" })).id;
});

describe("createApproval", () => {
  it("stores an APPROVED approval with the shown snapshot and supersedes a live one for the subject", async () => {
    const subject = crypto.randomUUID();
    const first = await approval({ subjectRef: subject });
    expect(first.status).toBe("APPROVED");
    expect(first.shownSnapshot).toEqual({ answer: "exactly what was shown" });
    const second = await approval({ subjectRef: subject, hash: "b".repeat(64) });
    expect((await repos.getApproval(ctx(), first.id))?.status).toBe("REJECTED");
    expect((await repos.getApproval(ctx(), first.id))?.endReason).toBe("SUPERSEDED");
    expect((await repos.getLiveApprovalForSubject(ctx(), "rfi_answer", subject))?.id).toBe(
      second.id,
    );
  });

  it("refuses a malformed hash, an unknown kind and a reused nonce", async () => {
    await expect(approval({ hash: "not-a-hash" })).rejects.toThrow();
    await expect(approval({ kind: "payout" as never })).rejects.toThrow();
    const a = await approval();
    await expect(approval({ nonce: a.nonce })).rejects.toThrow();
  });

  it("reads EXPIRED once past its expiry, before any sweep ran", async () => {
    const a = await approval({ expiresAt: new Date(Date.now() + 2_000) });
    expect(repos.effectiveApprovalStatus(a, new Date(Date.now() + 5_000))).toBe("EXPIRED");
    expect(repos.effectiveApprovalStatus(a, new Date())).toBe("APPROVED");
  });
});

describe("the bound content cannot change", () => {
  it("a trigger refuses a change to the hash, snapshot, nonce, approver or expiry for every role", async () => {
    const a = await approval();
    for (const set of [
      `hash = '${"c".repeat(64)}'`,
      `shown_snapshot = '{"answer":"changed"}'`,
      `nonce = 'other'`,
      `expires_at = now() + interval '9 days'`,
      `subject_ref = 'other'`,
    ]) {
      const sql = `UPDATE approvals SET ${set} WHERE id = '${a.id}'`;
      expect(await sqlStateOf(db().appUrl, sql), `app role: ${set}`).toBe("23000");
      expect(await sqlStateOf(db().migrationUrl, sql), `migration role: ${set}`).toBe("23000");
    }
    expect((await repos.getApproval(ctx(), a.id))?.hash).toBe(HASH);
  });
});

describe("consumeApproval", () => {
  it("consumes once and writes the INTENT respond attempt in the same transaction", async () => {
    const a = await approval();
    const result = await repos.consumeApproval(ctx(), { approvalId: a.id, expectedHash: HASH });
    if (result.outcome !== "consumed") throw new Error("expected consumed");
    expect(result.approval.status).toBe("CONSUMED");
    expect(result.approval.consumedAt).toBeInstanceOf(Date);
    expect(result.attempt).toMatchObject({
      kind: "respond",
      refId: a.subjectRef,
      status: "INTENT",
    });
    expect(result.attempt.response).toEqual({ approvalId: a.id, hash: HASH });
    // Sequential replay: refused, no second attempt.
    const again = await repos.consumeApproval(ctx(), { approvalId: a.id, expectedHash: HASH });
    expect(again).toEqual({ outcome: "refused", reason: "NOT_APPROVED" });
    expect(await repos.listAttemptsForRefs(ctx(), "respond", [a.subjectRef])).toHaveLength(1);
  });

  it("20 concurrent consumers: exactly one CONSUMED row, one attempt, one winner", async () => {
    const a = await approval();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        repos.consumeApproval(ctx(), { approvalId: a.id, expectedHash: HASH }),
      ),
    );
    expect(results.filter((r) => r.outcome === "consumed")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "refused")).toHaveLength(19);
    expect(await repos.listAttemptsForRefs(ctx(), "respond", [a.subjectRef])).toHaveLength(1);
    const rows = await withClient(db().migrationUrl, (c) =>
      c.query("SELECT status FROM approvals WHERE id = $1", [a.id]),
    );
    expect(rows.rows).toEqual([{ status: "CONSUMED" }]);
  });

  it("refuses a different hash without consuming", async () => {
    const a = await approval();
    const r = await repos.consumeApproval(ctx(), {
      approvalId: a.id,
      expectedHash: "d".repeat(64),
    });
    expect(r).toEqual({ outcome: "refused", reason: "HASH_MISMATCH" });
    expect((await repos.getApproval(ctx(), a.id))?.status).toBe("APPROVED");
    expect(await repos.listAttemptsForRefs(ctx(), "respond", [a.subjectRef])).toEqual([]);
  });

  it("refuses an expired approval", async () => {
    const a = await approval({ expiresAt: new Date(Date.now() + 100) });
    await new Promise((r) => setTimeout(r, 250));
    const r = await repos.consumeApproval(ctx(), { approvalId: a.id, expectedHash: HASH });
    expect(r).toEqual({ outcome: "refused", reason: "EXPIRED" });
    expect(await repos.listAttemptsForRefs(ctx(), "respond", [a.subjectRef])).toEqual([]);
  });

  it("refuses a rejected approval", async () => {
    const a = await approval();
    await repos.endApproval(ctx(), a.id, "REJECTED", "REJECTED_BY_USER");
    expect(await repos.consumeApproval(ctx(), { approvalId: a.id, expectedHash: HASH })).toEqual({
      outcome: "refused",
      reason: "NOT_APPROVED",
    });
  });

  it("a failure after the consume UPDATE rolls it back: the approval is still APPROVED", async () => {
    const taken = newRequestId();
    const other = await approval();
    const first = await repos.consumeApproval(ctx(), {
      approvalId: other.id,
      expectedHash: HASH,
      requestId: taken,
    });
    expect(first.outcome).toBe("consumed");
    const a = await approval();
    // The attempt insert collides on request_id, after the approval UPDATE already ran.
    await expect(
      repos.consumeApproval(ctx(), { approvalId: a.id, expectedHash: HASH, requestId: taken }),
    ).rejects.toBeInstanceOf(DuplicateRequestIdError);
    const after = await repos.getApproval(ctx(), a.id);
    expect(after?.status).toBe("APPROVED");
    expect(after?.consumedAt).toBeNull();
    expect(await repos.listAttemptsForRefs(ctx(), "respond", [a.subjectRef])).toEqual([]);
    // And a failure in the caller's own in-transaction work rolls back too.
    await expect(
      repos.consumeApproval(ctx(), {
        approvalId: a.id,
        expectedHash: HASH,
        inTransaction: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    expect((await repos.getApproval(ctx(), a.id))?.status).toBe("APPROVED");
    expect(await repos.listAttemptsForRefs(ctx(), "respond", [a.subjectRef])).toEqual([]);
  });

  it("kill switch: nothing is consumed, the approval reads EXPIRED (KILL_SWITCH), no attempt", async () => {
    const a = await approval();
    await setFlag(false);
    try {
      const r = await repos.consumeApproval(ctx(), { approvalId: a.id, expectedHash: HASH });
      expect(r).toEqual({ outcome: "refused", reason: "KILL_SWITCH" });
      const after = await repos.getApproval(ctx(), a.id);
      expect(after?.status).toBe("EXPIRED");
      expect(after?.endReason).toBe("KILL_SWITCH");
      expect(await repos.listAttemptsForRefs(ctx(), "respond", [a.subjectRef])).toEqual([]);
    } finally {
      await setFlag(true);
    }
  });
});

describe("sweeps", () => {
  it("the kill-switch sweep expires every live approval of every business; consumed ones stay", async () => {
    const live = await approval();
    const consumed = await approval();
    await repos.consumeApproval(ctx(), { approvalId: consumed.id, expectedHash: HASH });
    const ended = await repos.expireAllLiveApprovalsForKillSwitch(db().app.db);
    expect(ended.map((e) => e.id)).toContain(live.id as ApprovalId);
    expect(ended.map((e) => e.id)).not.toContain(consumed.id as ApprovalId);
    expect((await repos.getApproval(ctx(), live.id))?.endReason).toBe("KILL_SWITCH");
    expect((await repos.getApproval(ctx(), consumed.id))?.status).toBe("CONSUMED");
  });

  it("the TTL sweep expires approvals past expires_at only", async () => {
    const due = await approval({ expiresAt: new Date(Date.now() + 100) });
    const later = await approval();
    await new Promise((r) => setTimeout(r, 250));
    const ended = await repos.expireDueApprovals(db().app.db, new Date());
    expect(ended.map((e) => e.id)).toContain(due.id);
    expect(ended.map((e) => e.id)).not.toContain(later.id);
    expect((await repos.getApproval(ctx(), due.id))?.endReason).toBe("TTL");
  });
});
