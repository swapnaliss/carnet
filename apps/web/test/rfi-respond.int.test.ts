// M2-07: the respond executor on recorded Airwallex bodies. Approve (the real approve function) ->
// `rfi.respond` (the real executor) -> the stubbed Airwallex. Covers the respond body, the 4xx path, the
// CLOSED path, the audit trail and the no-op on an already answered RFI. Nothing reaches the network.
import { getAttempt, getRfi, listAttemptsForRefs, listAudit } from "@carnet/db";
import type { ApprovalId, AttemptId } from "@carnet/domain";
import { afterAll, describe, expect, it } from "vitest";
import { runRfiRespond } from "../src/worker/handlers/rfi-respond";
import { type Approvable, approved, setupApprovable } from "./approval-support";
import { fixtureRfi, retarget } from "./rfi-support";
import { blockedCalls, loadFixture, query, webTestDatabase } from "./support";

const db = webTestDatabase();
afterAll(() => expect(blockedCalls).toEqual([]));

const run = (a: Approvable, ap: { id: string; hash: string }) =>
  runRfiRespond(a.ctx, {
    businessId: a.businessId,
    approvalId: ap.id as ApprovalId,
    hash: ap.hash,
  });

const attemptsOf = (a: Approvable) => listAttemptsForRefs(a.repo, "respond", [a.rfi.id]);
const stateOf = async (a: Approvable) => (await getRfi(a.repo, a.rfi.id))?.state;

describe("approve then respond (happy path)", () => {
  it("answers every question with the recorded upload's file id, CONFIRMED, RFI ANSWERED", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    expect(await stateOf(a)).toBe("APPROVED");

    // What the database holds at the moment the respond call is made.
    let attemptAtCall: string | undefined;
    let rfiAtCall: string | undefined;
    a.stub.on("POST", /\/respond$/, async () => {
      attemptAtCall = (await attemptsOf(a))[0]?.status;
      rfiAtCall = await stateOf(a);
      const answered = retarget(fixtureRfi("rfi-check2-respond-full"), { id: a.airwallexRfiId });
      a.current.set(a.airwallexRfiId, answered);
      return Response.json(answered);
    });

    const result = await run(a, ap);
    expect(result.outcome).toBe("confirmed");
    expect(attemptAtCall).toBe("SENT_TO_AIRWALLEX");
    expect(rfiAtCall).toBe("ANSWER_SUBMITTING");

    // The body answers all questions; the attachment carries the file id of the recorded upload.
    const [respond] = a.responds();
    expect(respond?.path).toBe(`/api/v1/rfis/${a.airwallexRfiId}/respond`);
    const recordedFileId = (
      loadFixture("rfi-check2-upload-pdf").response.body as { file_id: string }
    ).file_id;
    const questions = (
      respond?.json as { questions: { id: string; answer: Record<string, unknown> }[] }
    ).questions;
    expect(questions.map((q) => q.id).sort()).toEqual(
      a.questions.map((q) => q.airwallexQuestionId).sort(),
    );
    const byType = Object.fromEntries(questions.map((q) => [q.answer.type as string, q.answer]));
    expect(byType.TEXT).toEqual({ type: "TEXT", text: "Payment for supplier invoice INV-1001" });
    expect(byType.ATTACHMENT).toEqual({
      type: "ATTACHMENT",
      attachments: [{ file_id: recordedFileId }],
    });

    // One upload, within the files host's limits (PDF, filename at most 50 characters).
    expect(a.uploads()).toHaveLength(1);
    const form = a.uploads()[0] as { form?: FormData };
    const file = form.form?.get("file") as File;
    expect(file.name.length).toBeLessThanOrEqual(50);
    expect(file.type).toBe("application/pdf");

    const [attempt] = await attemptsOf(a);
    expect(attempt).toMatchObject({ status: "CONFIRMED", kind: "respond", refId: a.rfi.id });
    expect(await stateOf(a)).toBe("ANSWERED");
    const [consumed] = await query<{ status: string }>(
      db().appUrl,
      "SELECT status FROM approvals WHERE id = $1",
      [ap.id],
    );
    expect(consumed?.status).toBe("CONSUMED");
    // `answer.submitted` is published (outbox) for M2-06.
    const jobs = await query<{ payload: { rfiId: string } }>(
      db().appUrl,
      "SELECT payload FROM outbox_jobs WHERE kind = 'answer.submitted'",
    );
    expect(jobs.map((j) => j.payload.rfiId)).toContain(a.rfi.id);
    // An RFI never touched a payment's money status: this business has no payment at all here.
    expect(
      await query(db().appUrl, "SELECT 1 FROM payments WHERE business_id = $1", [a.businessId]),
    ).toEqual([]);
  });

  it("a second run for the same approval is a no-op success: no second consume, upload or respond", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    expect((await run(a, ap)).outcome).toBe("confirmed");
    const again = await run(a, ap);
    expect(again.outcome).toBe("skipped");
    expect(a.responds()).toHaveLength(1);
    expect(a.uploads()).toHaveLength(1);
    expect(await attemptsOf(a)).toHaveLength(1);
  });
});

describe("every step writes an audit entry, and none carries answer text or a secret", () => {
  it("records grant, consume, attempt, upload, send and confirmation", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    await run(a, ap);
    const entries = await listAudit(a.repo, 500);
    const actions = entries.map((e) => e.action);
    for (const expected of [
      "approval.granted",
      "approval.consumed",
      "attempt.created",
      "attachment.uploaded",
      "attempt.sent",
      "respond.confirmed",
      "answer.submitted",
      "rfi.transition",
    ]) {
      expect(actions, expected).toContain(expected);
    }
    const transitions = entries
      .filter((e) => e.action === "rfi.transition")
      .map((e) => `${(e.data as { from: string }).from}>${(e.data as { to: string }).to}`);
    expect(transitions).toEqual(
      expect.arrayContaining([
        "DRAFT_READY>APPROVED",
        "APPROVED>ANSWER_SUBMITTING",
        "ANSWER_SUBMITTING>ANSWERED",
      ]),
    );
    const upload = entries.find((e) => e.action === "attachment.uploaded");
    expect(upload?.data).toMatchObject({ documentId: a.documentId });
    expect((upload?.data as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);

    const dump = JSON.stringify(entries.map((e) => e.data));
    expect(dump).not.toContain("Payment for supplier invoice INV-1001"); // hash plus snapshot reference only
    expect(dump).not.toMatch(/api[_-]?key|secret|bearer|password/i);
  });
});

describe("a 4xx rejection", () => {
  it("marks the attempt REJECTED with the provider error and sends the RFI back to NEEDS_OWNER", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    const partial = loadFixture("rfi-check2-respond-partial-text").response; // 400 invalid_argument
    a.stub.on("POST", /\/respond$/, partial);
    const result = await run(a, ap);
    expect(result.outcome).toBe("rejected");
    const [attempt] = await attemptsOf(a);
    expect(attempt?.status).toBe("REJECTED");
    expect(attempt?.response).toMatchObject({
      error: { kind: "AirwallexApiError", code: "invalid_argument" },
    });
    expect(JSON.stringify(attempt?.response)).toContain("Please answer all questions");
    expect(await stateOf(a)).toBe("NEEDS_OWNER");
    const rejected = (await listAudit(a.repo, 100)).find((e) => e.action === "respond.rejected");
    expect(JSON.stringify(rejected?.data)).toContain("invalid_argument");
    // The attempt is final: a re-run does not send again.
    expect((await run(a, ap)).outcome).toBe("skipped");
    expect(a.responds()).toHaveLength(1);
  });

  it("invalid_state with the RFI CLOSED: attempt REJECTED, RFI EXPIRED", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    // Airwallex closes the RFI at the moment of the call: respond says invalid state, the lookup says CLOSED.
    a.stub.on("POST", /\/respond$/, (call) => {
      void call;
      const closed = retarget(fixtureRfi("rfi-check5-fetch-after-close"), { id: a.airwallexRfiId });
      a.current.set(a.airwallexRfiId, closed);
      return Response.json({ code: "invalid_state_for_operation" }, { status: 400 });
    });
    const result = await run(a, ap);
    expect(result.outcome).toBe("rejected");
    expect(await stateOf(a)).toBe("EXPIRED");
    expect((await attemptsOf(a))[0]?.status).toBe("REJECTED");
  });

  it("invalid_state with the RFI ANSWERED in Airwallex: treated as done (CONFIRMED)", async () => {
    const a = await setupApprovable(db().app.db);
    const ap = await approved(a);
    a.stub.on("POST", /\/respond$/, () => {
      a.current.set(
        a.airwallexRfiId,
        retarget(fixtureRfi("rfi-check2-fetch-after-full"), { id: a.airwallexRfiId }),
      );
      return Response.json({ code: "invalid_state_for_operation" }, { status: 400 });
    });
    expect((await run(a, ap)).outcome).toBe("confirmed");
    expect(await stateOf(a)).toBe("ANSWERED");
    const attempt = await getAttempt(a.repo, (await attemptsOf(a))[0]?.id as AttemptId);
    expect(attempt?.status).toBe("CONFIRMED");
  });
});
