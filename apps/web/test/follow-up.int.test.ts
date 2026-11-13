// M3-05 on Postgres, over recorded responses: a follow-up round (round 2) reuses what the owner approved in
// round 1 without a model call, drafts changed and appended questions through the M2-05 pipeline, blocks the
// whole RFI when a reused answer no longer verifies, and always needs a NEW bound approval.
import {
  consumeApproval,
  createBusiness,
  type Db,
  getLatestDraft,
  getRfi,
  insertFactsVersion,
  listDraftAnswers,
  repoCtx,
  schema,
} from "@carnet/db";
import type { ApprovalId, BusinessId, ExtractedFact } from "@carnet/domain";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApproveBody } from "../src/components/rfi/view";
import { approveRfiAnswer } from "../src/server/approvals";
import { loadHoldView } from "../src/server/hold";
import {
  countingTransport,
  type Evidence,
  endUseAppended,
  loadEvidence,
  type Origin,
  purposeReopened,
  recordedReply,
  runDraftJob,
  SET,
  seedApprovedRound1,
  seedFollowUpRfi,
} from "./follow-up-support";
import { webTestDatabase } from "./support";

const db = webTestDatabase();
let businessId: BusinessId;
let ev: Evidence;
let origin: Origin;
const repo = () => repoCtx(db().app.db, businessId);
const dbh = (): Db => db().app.db;

beforeAll(async () => {
  businessId = await createBusiness(dbh(), { name: "follow-up-co" });
  ev = await loadEvidence(repo());
  origin = await seedApprovedRound1(dbh(), businessId, ev);
}, 120_000);

const runsFor = async (rfiId: string) =>
  (await dbh().select().from(schema.agentRuns).where(eq(schema.agentRuns.ref, rfiId))).length;

const refuse: () => Promise<Response> = async () => {
  throw new Error("the model must not be called");
};

describe("round 2: reuse of an approved answer", () => {
  it("round 2: a reopened question with the same wording is reused with zero model calls and shows when it was approved", async () => {
    const f = await seedFollowUpRfi(dbh(), origin, [purposeReopened()], "RD-reuse-1");
    const spy = countingTransport(refuse);
    await runDraftJob(dbh(), businessId, f.rfiId, 2, spy.transport);
    // zero model calls: no request, and no harness run row for this RFI.
    expect(spy.calls()).toBe(0);
    expect(await runsFor(f.rfiId)).toBe(0);

    const rfi = await getRfi(repo(), f.rfiId);
    expect(rfi).toMatchObject({ state: "DRAFT_READY", round: 2 });
    const draft = await getLatestDraft(repo(), f.rfiId, 2);
    expect(draft).toMatchObject({ origin: "system", round: 2 });
    const [answer] = await listDraftAnswers(repo(), draft?.id ?? "");
    expect(answer).toMatchObject({ status: "VERIFIED" });
    expect(answer?.reused).toMatchObject({ reused: true, source_approval_id: origin.approvalId });
    expect(answer?.citations.length).toBeGreaterThan(0);

    const view = await loadHoldView(repo(), rfi as NonNullable<typeof rfi>, "owner");
    expect(view.questions[0]?.follow_up).toMatchObject({ kind: "unchanged" });
    expect(view.questions[0]?.answer?.reuse?.source_approval_id).toBe(origin.approvalId);
  });

  it("round 2: a changed question is drafted by the M2-05 pipeline (one model call) and is not marked reused", async () => {
    const changed = {
      ...purposeReopened(),
      description: "Describe in detail what this payment is for and who benefits.",
    };
    const f = await seedFollowUpRfi(dbh(), origin, [changed], "RD-changed-1");
    const spy = countingTransport(recordedReply(`${SET}-r1`, ev, f.qIds));
    await runDraftJob(dbh(), businessId, f.rfiId, 2, spy.transport);
    expect(spy.calls()).toBe(1);
    expect(await runsFor(f.rfiId)).toBe(1);
    const draft = await getLatestDraft(repo(), f.rfiId, 2);
    expect(draft?.origin).toBe("model");
    const [answer] = await listDraftAnswers(repo(), draft?.id ?? "");
    expect(answer?.reused).toBeNull();
    const rfi = await getRfi(repo(), f.rfiId);
    const view = await loadHoldView(repo(), rfi as NonNullable<typeof rfi>, "owner");
    expect(view.questions[0]?.follow_up).toMatchObject({
      kind: "changed",
      previous: { description: "Describe what this payment is for." },
    });
  });

  it("round 2: an appended question is drafted by the model while the reopened one is reused", async () => {
    const f = await seedFollowUpRfi(
      dbh(),
      origin,
      [purposeReopened(), endUseAppended()],
      "RD-mixed-1",
    );
    const spy = countingTransport(recordedReply(`${SET}-r2`, ev, f.qIds));
    await runDraftJob(dbh(), businessId, f.rfiId, 2, spy.transport);
    expect(spy.calls()).toBe(1);
    const draft = await getLatestDraft(repo(), f.rfiId, 2);
    const answers = await listDraftAnswers(repo(), draft?.id ?? "");
    const byQ = new Map(answers.map((a) => [a.questionId, a]));
    expect(byQ.get(f.qIds.get("q-rhein-purpose") ?? "")?.reused).not.toBeNull();
    expect(byQ.get(f.qIds.get("q-rhein-r2-end_use") ?? "")?.reused).toBeNull();
    // The recorded model could not ground the end-use question: the whole RFI is blocked.
    expect(draft?.state).toBe("NEEDS_OWNER");
    expect((await getRfi(repo(), f.rfiId))?.state).toBe("NEEDS_OWNER");
  });
});

describe("round 2: a fresh, bound approval", () => {
  it("round 2: applying reused answers creates a new approval with a different hash; the round 1 approval cannot be used again", async () => {
    const f = await seedFollowUpRfi(dbh(), origin, [purposeReopened()], "RD-approve-1");
    await runDraftJob(dbh(), businessId, f.rfiId, 2, refuse);
    const rfi = await getRfi(repo(), f.rfiId);
    const view = await loadHoldView(repo(), rfi as NonNullable<typeof rfi>, "owner");
    const body = buildApproveBody(view);
    expect(body).not.toBeNull();
    const res = await approveRfiAnswer(
      {
        repo: repo(),
        userId: origin.userId as never,
        rfiId: f.rfiId,
        body: body as unknown as Parameters<typeof approveRfiAnswer>[0]["body"],
        key: `apply-${crypto.randomUUID()}`,
        requestId: "req-apply",
      },
      { executionEnabled: async () => true },
    );
    expect(res.status).toBe(201);
    const next = ((await res.json()) as { approval: { id: string; hash: string } }).approval;
    expect(next.id).not.toBe(origin.approvalId);
    expect(next.hash).not.toBe(origin.approvalHash);

    // The round 1 approval was consumed by round 1: it cannot be consumed again, so nothing is sent.
    const again = await consumeApproval(repo(), {
      approvalId: origin.approvalId,
      expectedHash: origin.approvalHash,
    });
    expect(again).toEqual({ outcome: "refused", reason: "NOT_APPROVED" });
    // And it is no stand-in for the new content: the new approval's hash is the only one that matches.
    const wrong = await consumeApproval(repo(), {
      approvalId: next.id as ApprovalId,
      expectedHash: origin.approvalHash,
    });
    expect(wrong).toEqual({ outcome: "refused", reason: "HASH_MISMATCH" });
  });
});

const fact = (quote: string): ExtractedFact => ({
  key: "total",
  value: "EUR 9,999.00",
  parsed: { type: "amount", minor: "999900", currency: "EUR" },
  quote,
  page: 1,
  quote_verified: true,
  needs_confirmation: false,
  issues: [],
});

describe("round 2: a reused answer that no longer verifies blocks the whole RFI", () => {
  // Last: it supersedes the invoice's facts for this business.
  it("round 2: a superseded cited fact makes the question NEEDS_OWNER (REUSE_STALE) with zero model calls", async () => {
    await insertFactsVersion(repo(), {
      documentId: ev.invoiceDocumentId as never,
      source: "model",
      status: "EXTRACTED",
      textLayer: true,
      facts: [fact("Total due: EUR 9,999.00")],
    });
    const f = await seedFollowUpRfi(dbh(), origin, [purposeReopened()], "RD-stale-1");
    const spy = countingTransport(refuse);
    await runDraftJob(dbh(), businessId, f.rfiId, 2, spy.transport);
    expect(spy.calls()).toBe(0);
    const rfi = await getRfi(repo(), f.rfiId);
    expect(rfi?.state).toBe("NEEDS_OWNER");
    const draft = await getLatestDraft(repo(), f.rfiId, 2);
    const [answer] = await listDraftAnswers(repo(), draft?.id ?? "");
    expect(answer).toMatchObject({ status: "NEEDS_OWNER", reasonCode: "REUSE_STALE", text: "" });
    const view = await loadHoldView(repo(), rfi as NonNullable<typeof rfi>, "owner");
    // The approve request for this view still carries a NEEDS_OWNER answer, which the server refuses.
    expect(view.questions[0]?.answer?.reuse).not.toBeNull();
    expect(view.rfi.state).toBe("NEEDS_OWNER");
  });
});
