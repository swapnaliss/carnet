// M2-07 AC 7 (unknown outcomes): a respond that times out leaves the attempt UNKNOWN with its original
// request_id. The reconcile pass looks the RFI up: ANSWERED confirms (no second respond), ACTION_REQUIRED
// with the approved questions re-sends the SAME attempt (same request_id), CLOSED expires the RFI, and a
// changed RFI asks for a new approval. A new request_id is never minted. Recorded bodies only.
import { getAttempt, getRfi, listAttemptsForRefs } from "@carnet/db";
import type { ApprovalId, AttemptId } from "@carnet/domain";
import { afterAll, describe, expect, it } from "vitest";
import { hangUntilAborted } from "../../../packages/airwallex/test/fixture-loader";
import { runRfiRespond } from "../src/worker/handlers/rfi-respond";
import { runReconcile } from "../src/worker/reconcile";
import { type Approvable, approved, setupApprovable } from "./approval-support";
import { fixtureRfi, retarget } from "./rfi-support";
import { blockedCalls, webTestDatabase } from "./support";

const db = webTestDatabase();
afterAll(() => expect(blockedCalls).toEqual([]));

/** An approval whose respond call times out (the client's 20 ms timeout, one attempt). */
async function timedOut() {
  const a = await setupApprovable(db().app.db, { client: { timeoutMs: 20, maxAttempts: 1 } });
  const original = a.current.get(a.airwallexRfiId);
  a.stub.on("POST", /\/respond$/, (_call, init) => hangUntilAborted(init));
  const ap = await approved(a);
  const out = await runRfiRespond(a.ctx, {
    businessId: a.businessId,
    approvalId: ap.id as ApprovalId,
    hash: ap.hash,
  });
  expect(out.outcome).toBe("unknown");
  const [attempt] = await listAttemptsForRefs(a.repo, "respond", [a.rfi.id]);
  expect(attempt?.status).toBe("UNKNOWN");
  return { a, ap, attempt: attempt as NonNullable<typeof attempt>, original };
}

const stateOf = async (a: Approvable) => (await getRfi(a.repo, a.rfi.id))?.state;
const reload = (a: Approvable, id: string) => getAttempt(a.repo, id as AttemptId);

describe("a respond that times out", () => {
  it("is UNKNOWN with the original request_id and the RFI stays ANSWER_SUBMITTING", async () => {
    const { a, attempt } = await timedOut();
    expect(attempt.requestId).toMatch(/\S/);
    expect(await stateOf(a)).toBe("ANSWER_SUBMITTING");
    expect(a.responds()).toHaveLength(1);
  });

  it("ANSWERED in Airwallex: reconcile sets CONFIRMED, RFI ANSWERED, and sends no second respond", async () => {
    const { a, attempt } = await timedOut();
    a.current.set(
      a.airwallexRfiId,
      retarget(fixtureRfi("rfi-check2-fetch-after-full"), { id: a.airwallexRfiId }),
    );
    const summary = await runReconcile(a.ctx);
    expect(summary.attemptsConfirmed).toBeGreaterThanOrEqual(1);
    const after = await reload(a, attempt.id);
    expect(after?.status).toBe("CONFIRMED");
    expect(after?.requestId).toBe(attempt.requestId);
    expect(await stateOf(a)).toBe("ANSWERED");
    expect(a.responds()).toHaveLength(1);
    // A second pass finds nothing to do.
    await runReconcile(a.ctx);
    expect(a.responds()).toHaveLength(1);
  });

  it("ACTION_REQUIRED with the approved questions: the retry reuses the same attempt and request_id", async () => {
    const { a, attempt } = await timedOut();
    // The lookup shows the RFI unchanged; the next respond is answered from the recorded success.
    a.stub.on("POST", /\/respond$/, (call) => {
      const answered = retarget(fixtureRfi("rfi-check2-respond-full"), {
        id: call.path.split("/")[4] ?? "",
      });
      a.current.set(a.airwallexRfiId, answered);
      return Response.json(answered);
    });
    await runReconcile(a.ctx);
    const attempts = await listAttemptsForRefs(a.repo, "respond", [a.rfi.id]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.id).toBe(attempt.id);
    expect(attempts[0]?.requestId).toBe(attempt.requestId);
    expect(attempts[0]?.status).toBe("CONFIRMED");
    expect(a.responds()).toHaveLength(2);
    expect(await stateOf(a)).toBe("ANSWERED");
  });

  it("CLOSED in Airwallex: the RFI is EXPIRED and nothing is sent again", async () => {
    const { a, attempt } = await timedOut();
    a.current.set(
      a.airwallexRfiId,
      retarget(fixtureRfi("rfi-check5-fetch-after-close"), { id: a.airwallexRfiId }),
    );
    await runReconcile(a.ctx);
    expect(await stateOf(a)).toBe("EXPIRED");
    expect((await reload(a, attempt.id))?.status).toBe("REJECTED");
    expect(a.responds()).toHaveLength(1);
  });

  it("the RFI changed meanwhile: NEEDS_OWNER, a new approval is required, no new request_id is minted", async () => {
    const { a, attempt, original } = await timedOut();
    const changed = structuredClone(original) as NonNullable<typeof original>;
    (changed as { updated_at: string }).updated_at = "2099-01-01T00:00:00+0000";
    a.current.set(a.airwallexRfiId, changed);
    await runReconcile(a.ctx);
    expect(await stateOf(a)).toBe("NEEDS_OWNER");
    expect((await reload(a, attempt.id))?.status).toBe("REJECTED");
    expect(await listAttemptsForRefs(a.repo, "respond", [a.rfi.id])).toHaveLength(1);
    expect(a.responds()).toHaveLength(1);
  });
});
