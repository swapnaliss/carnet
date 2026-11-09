// M2-07 AC 3 and 4 (TOCTOU and tamper): after approval, anything that changes what was approved makes the
// executor refuse without calling respond; the attempt shows the refusal code. A privileged tamper with
// the stored attachment bytes or the stored answer text is caught by the re-hash and the re-derived hash.
import { getRfi, listAttemptsForRefs } from "@carnet/db";
import type { ApprovalId } from "@carnet/domain";
import { afterAll, describe, expect, it } from "vitest";
import { withClient } from "../../../packages/db/test/harness";
import { type RespondAttemptRecord, runRfiRespond } from "../src/worker/handlers/rfi-respond";
import { type Approvable, approved, setupApprovable } from "./approval-support";
import { fixtureRfi, retarget } from "./rfi-support";
import { blockedCalls, webTestDatabase } from "./support";

const db = webTestDatabase();
afterAll(() => expect(blockedCalls).toEqual([]));

async function refusal(a: Approvable, ap: { id: string; hash: string }) {
  const result = await runRfiRespond(a.ctx, {
    businessId: a.businessId,
    approvalId: ap.id as ApprovalId,
    hash: ap.hash,
  });
  const [attempt] = await listAttemptsForRefs(a.repo, "respond", [a.rfi.id]);
  return { result, attempt, record: (attempt?.response ?? {}) as RespondAttemptRecord };
}

function expectNothingSent(a: Approvable) {
  expect(a.responds()).toEqual([]);
  expect(a.uploads()).toEqual([]);
}

describe("the RFI changes after approval", () => {
  it("a newer updated_at: refused RFI_UPDATED, RFI NEEDS_OWNER, nothing sent", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    const wire = a.current.get(a.airwallexRfiId);
    if (!wire) throw new Error("no wire");
    wire.updated_at = "2026-11-30T09:00:00+0000";
    const { result, attempt, record } = await refusal(a, ap);
    expect(result).toMatchObject({ outcome: "refused", code: "RFI_UPDATED" });
    expect(attempt?.status).toBe("REJECTED");
    expect(record.refusal?.code).toBe("RFI_UPDATED");
    expect((await getRfi(a.repo, a.rfi.id))?.state).toBe("NEEDS_OWNER");
    expectNothingSent(a);
  });

  it("an added question: refused QUESTIONS_CHANGED", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    const questions = a.current.get(a.airwallexRfiId)?.active_request?.questions;
    const first = questions?.[0];
    if (!questions || !first) throw new Error("no questions");
    questions.push({ ...structuredClone(first), id: crypto.randomUUID() });
    const { result, record } = await refusal(a, ap);
    expect(result).toMatchObject({ outcome: "refused", code: "QUESTIONS_CHANGED" });
    expect(record.refusal?.code).toBe("QUESTIONS_CHANGED");
    expectNothingSent(a);
  });

  it("a reworded question: refused QUESTIONS_CHANGED", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    const first = a.current.get(a.airwallexRfiId)?.active_request?.questions[0];
    if (!first) throw new Error("no questions");
    first.title = { en: "A different question?", zh: null };
    expect((await refusal(a, ap)).result).toMatchObject({ code: "QUESTIONS_CHANGED" });
    expectNothingSent(a);
  });

  it("closed by Airwallex: refused, RFI EXPIRED, payment untouched", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    a.current.set(
      a.airwallexRfiId,
      retarget(fixtureRfi("rfi-check5-fetch-after-close"), { id: a.airwallexRfiId }),
    );
    const { result, record } = await refusal(a, ap);
    expect(result).toMatchObject({ outcome: "refused", code: "RFI_NOT_ACTION_REQUIRED" });
    expect(record.refusal?.code).toBe("RFI_NOT_ACTION_REQUIRED");
    expect((await getRfi(a.repo, a.rfi.id))?.state).toBe("EXPIRED");
    expectNothingSent(a);
  });

  it("answered elsewhere: refused, RFI ANSWERED, nothing sent", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    a.current.set(
      a.airwallexRfiId,
      retarget(fixtureRfi("rfi-check2-fetch-after-full"), { id: a.airwallexRfiId }),
    );
    expect((await refusal(a, ap)).result).toMatchObject({ code: "RFI_NOT_ACTION_REQUIRED" });
    expect((await getRfi(a.repo, a.rfi.id))?.state).toBe("ANSWERED");
    expectNothingSent(a);
  });
});

describe("tamper after approval", () => {
  it("altered attachment bytes: refused ATTACHMENT_CHANGED (re-hash mismatch), nothing uploaded", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    // The documents table makes this impossible for the app role (immutability trigger and a CHECK that
    // recomputes the hash); a privileged actor lifts both to simulate storage tampering.
    await withClient(db().migrationUrl, async (c) => {
      await c.query("ALTER TABLE documents DISABLE TRIGGER documents_immutable_content");
      await c.query("ALTER TABLE documents DROP CONSTRAINT documents_sha256_check");
      // One byte flipped: same size, so only the hash can notice.
      await c.query(
        "UPDATE documents SET bytes = set_byte(bytes, 12, get_byte(bytes, 12) # 1) WHERE id = $1",
        [a.documentId],
      );
    });
    const { result, record } = await refusal(a, ap);
    expect(result).toMatchObject({ outcome: "refused", code: "ATTACHMENT_CHANGED" });
    expect(record.refusal?.code).toBe("ATTACHMENT_CHANGED");
    expectNothingSent(a);
  });

  it("a deleted attachment: refused ATTACHMENT_MISSING", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    await withClient(db().migrationUrl, (c) =>
      c.query("DELETE FROM documents WHERE id = $1", [a.documentId]),
    );
    expect((await refusal(a, ap)).result).toMatchObject({ code: "ATTACHMENT_MISSING" });
    expectNothingSent(a);
  });

  it("altered answer text in the stored snapshot: refused HASH_MISMATCH", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    await withClient(db().migrationUrl, async (c) => {
      await c.query("ALTER TABLE approvals DISABLE TRIGGER approvals_immutable_binding");
      try {
        await c.query(
          `UPDATE approvals SET shown_snapshot = jsonb_set(shown_snapshot, '{subject,answers,0,text}', '"Payment for something else"') WHERE id = $1`,
          [ap.id],
        );
        // Both answers: whichever is the TEXT answer gets changed too.
        await c.query(
          `UPDATE approvals SET shown_snapshot = jsonb_set(shown_snapshot, '{subject,answers,1,text}', '"Payment for something else"') WHERE id = $1`,
          [ap.id],
        );
      } finally {
        await c.query("ALTER TABLE approvals ENABLE TRIGGER approvals_immutable_binding");
      }
    });
    const { result, record } = await refusal(a, ap);
    expect(result).toMatchObject({ outcome: "refused", code: "HASH_MISMATCH" });
    expect(record.refusal?.code).toBe("HASH_MISMATCH");
    expectNothingSent(a);
  });

  it("an altered stored hash: the consume WHERE refuses (the job carries the approved hash)", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    await withClient(db().migrationUrl, async (c) => {
      await c.query("ALTER TABLE approvals DISABLE TRIGGER approvals_immutable_binding");
      try {
        await c.query("UPDATE approvals SET hash = $1 WHERE id = $2", ["f".repeat(64), ap.id]);
      } finally {
        await c.query("ALTER TABLE approvals ENABLE TRIGGER approvals_immutable_binding");
      }
    });
    const result = await runRfiRespond(a.ctx, {
      businessId: a.businessId,
      approvalId: ap.id as ApprovalId,
      hash: ap.hash,
    });
    expect(result).toEqual({ outcome: "consume_refused", reason: "HASH_MISMATCH" });
    expect(await listAttemptsForRefs(a.repo, "respond", [a.rfi.id])).toEqual([]);
    expectNothingSent(a);
  });
});

describe("an expired approval cannot be consumed", () => {
  it("approved in the past (30 min TTL, 1 hour ago): refused EXPIRED, draft back to DRAFT_READY, nothing sent", async () => {
    const a = await setupApprovable(db().app.db);
    const { approveRfiAnswer } = await import("../src/server/approvals");
    const res = await approveRfiAnswer(
      {
        repo: a.repo,
        userId: a.userId,
        rfiId: a.rfi.id,
        body: a.body(),
        key: "expired-approval-key",
        requestId: "r",
      },
      {
        now: () => new Date(Date.now() - 3600_000),
        ttlMinutes: 30,
        executionEnabled: async () => true,
      },
    );
    const { approval } = (await res.json()) as { approval: { id: string; hash: string } };
    const result = await runRfiRespond(a.ctx, {
      businessId: a.businessId,
      approvalId: approval.id as ApprovalId,
      hash: approval.hash,
    });
    expect(result).toEqual({ outcome: "consume_refused", reason: "EXPIRED" });
    expect((await getRfi(a.repo, a.rfi.id))?.state).toBe("DRAFT_READY");
    expect(await listAttemptsForRefs(a.repo, "respond", [a.rfi.id])).toEqual([]);
    expectNothingSent(a);
  });
});
