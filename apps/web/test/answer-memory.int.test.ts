// M2-06 end to end on Postgres: approve -> respond -> `answer.submitted` writes memory -> a follow-up
// round reuses the answer through POST /api/v1/rfis/{id}/reuse (the exact production spec). Proves the
// stored answer comes back with its citations and provenance, a changed fact makes it NEEDS_OWNER
// (REUSE_STALE), reuse is audited, makes no model call, and is tenant- and role-scoped.
import {
  createCounterparty,
  createPayment,
  type Db,
  getLatestDraft,
  insertDraft,
  insertFactsVersion,
  insertRfiQuestions,
  linkRfiToPayment,
  listAnswerMemory,
  listAttemptsForRefs,
  listAudit,
  listDraftAnswers,
  listRfiQuestions,
  repoCtx,
  updateRfi,
} from "@carnet/db";
import { type ApprovalId, type ExtractedFact, money, needsOwner } from "@carnet/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRouteKit, type RouteHandler } from "../src/lib/define-route";
import { rfiReuseSpec } from "../src/server/reuse-routes";
import { handleAnswerSubmittedMemory } from "../src/worker/handlers/answer-memory";
import { runRfiRespond } from "../src/worker/handlers/rfi-respond";
import { type Approvable, approved, setupApprovable } from "./approval-support";
import { addUser, ORIGIN, sessionCookie, setupAuthTestEnv } from "./auth/setup";
import { blockedCalls } from "./support";

const env = setupAuthTestEnv();
afterAll(() => expect(blockedCalls).toEqual([]));

const ANSWER = "Payment of invoice total USD 4,800.00";
const cookies = { owner: "", viewer: "", other: "" };
let reuse: RouteHandler;
let seq = 0;

const fact = (quote = "Total due: USD 4,800.00"): ExtractedFact => ({
  key: "total",
  value: "USD 4,800.00",
  parsed: { type: "amount", minor: "480000", currency: "USD" },
  quote,
  page: 1,
  quote_verified: true,
  needs_confirmation: false,
  issues: [],
});

beforeAll(async () => {
  const { db, passwords } = env();
  const kit = createRouteKit({
    authz: env().authz,
    db: () => db,
    logger: () => env().rt.logger,
    now: () => new Date(),
  });
  reuse = kit.defineRoute(rfiReuseSpec);
  cookies.other = await sessionCookie(env(), "owner@carnet.example", passwords.owner);
});

interface Scenario {
  a: Approvable;
  approvalId: ApprovalId;
  factVersionId: string;
  owner: string;
  viewer: string;
}

/** A business with a counterparty, an RFI whose round 1 was approved, sent and CONFIRMED. */
async function answeredRound1(options: { record?: boolean } = {}): Promise<Scenario> {
  const db: Db = env().db;
  const a = await setupApprovable(db);
  const repo = a.repo;
  const cp = await createCounterparty(repo, { name: "Rhein Supplies", country: "DE" });
  const payment = await createPayment(repo, {
    counterpartyId: cp.id,
    amount: money(480000n, "USD"),
    sourceCurrency: "USD",
    method: "SWIFT",
    reference: `memory-${++seq}`,
  });
  await linkRfiToPayment(repo, a.rfi.id, payment.id);
  const facts = await insertFactsVersion(repo, {
    documentId: a.documentId,
    source: "model",
    status: "EXTRACTED",
    textLayer: true,
    facts: [fact()],
  });
  const factVersionId = `${facts.version.id}#0`;
  const ap = await approved(a, {
    answers: a
      .body()
      .answers.map((x) =>
        x.type === "TEXT"
          ? { ...x, text: ANSWER, fact_version_ids: [factVersionId] }
          : { ...x, fact_version_ids: [factVersionId] },
      ),
  });
  const result = await runRfiRespond(a.ctx, {
    businessId: a.businessId,
    approvalId: ap.id as ApprovalId,
    hash: ap.hash,
  });
  expect(result.outcome).toBe("confirmed");
  if (options.record !== false) {
    const [attempt] = await listAttemptsForRefs(repo, "respond", [a.rfi.id]);
    await handleAnswerSubmittedMemory(
      {
        businessId: a.businessId,
        rfiId: a.rfi.id,
        approvalId: ap.id,
        attemptId: attempt?.id,
        stateMoved: true,
      },
      a.ctx,
      {} as never,
    );
  }
  const pw = "memory-test-password";
  const owner = `own-${++seq}@memory.test`;
  const viewer = `view-${seq}@memory.test`;
  await addUser(db, a.businessId, { email: owner, role: "owner", password: pw });
  await addUser(db, a.businessId, { email: viewer, role: "viewer", password: pw });
  return {
    a,
    approvalId: ap.id as ApprovalId,
    factVersionId,
    owner: await sessionCookie(env(), owner, pw),
    viewer: await sessionCookie(env(), viewer, pw),
  };
}

/** Airwallex opens round 2: the same purpose question, a new end-use question; a model draft exists. */
async function followUpRound(s: Scenario, purposeText?: { title: string; description: string }) {
  const repo = s.a.repo;
  const purpose = s.a.questions.find((q) => q.answerType === "TEXT");
  if (!purpose) throw new Error("no TEXT question");
  const base = {
    round: 2,
    comment: null,
    sources: [],
    reopened: false,
    needsDrafting: true,
    answerType: "TEXT",
  };
  await insertRfiQuestions(repo, s.a.rfi.id, [
    {
      ...base,
      airwallexQuestionId: "aq2-purpose",
      position: 0,
      title: { en: purposeText?.title ?? purpose.title.en, zh: null },
      description: { en: purposeText?.description ?? purpose.description.en, zh: null },
    },
    {
      ...base,
      airwallexQuestionId: "aq2-end-use",
      position: 1,
      title: { en: "Intended use", zh: null },
      description: { en: "What will you do with the goods?", zh: null },
    },
  ]);
  await updateRfi(repo, s.a.rfi.id, { state: "DRAFT_READY", round: 2 });
  const round2 = await listRfiQuestions(repo, s.a.rfi.id, 2);
  const { draft } = await insertDraft(repo, {
    rfiId: s.a.rfi.id,
    round: 2,
    origin: "model",
    draftKey: `job-${++seq}`,
    promptVersion: "draft@test",
    answers: round2.map((q) => ({
      questionId: q.id,
      text: "",
      citations: [],
      documentIds: [],
      verdict: needsOwner("CANNOT_ANSWER"),
    })),
  });
  return { round2, parent: draft };
}

function post(s: Scenario, cookie = s.owner, id = s.a.rfi.id as string) {
  return reuse(
    new Request(`${ORIGIN}/api/v1/rfis/${id}/reuse`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN },
    }),
    { params: Promise.resolve({ id }) },
  );
}

interface ReuseJson {
  reused: boolean;
  draft: null | {
    id: string;
    state: string;
    parent_draft_id: string;
    origin: string;
    answers: {
      question_id: string;
      text: string;
      status: string;
      reason_code: string | null;
      citations: { fact_version_id: string; quote: string }[];
      reuse: null | { reused: true; approved_on: string; source_approval_id: string };
    }[];
  };
}

describe("answer.submitted writes memory (AC 3, end to end)", () => {
  it("remembers the approved answers of a CONFIRMED respond, with the audit row", async () => {
    const s = await answeredRound1();
    const rows = await listAnswerMemory(s.a.repo);
    expect(rows.map((r) => r.answerText).sort()).toEqual(["", ANSWER]);
    const audit = (await listAudit(s.a.repo, 200)).filter((e) => e.action === "answer.memorised");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.data).toMatchObject({ approvalId: s.approvalId, recorded: 2, skipped: null });
  });

  it("a redelivered event remembers nothing twice", async () => {
    const s = await answeredRound1();
    const [attempt] = await listAttemptsForRefs(s.a.repo, "respond", [s.a.rfi.id]);
    await handleAnswerSubmittedMemory(
      {
        businessId: s.a.businessId,
        rfiId: s.a.rfi.id,
        approvalId: s.approvalId,
        attemptId: attempt?.id,
      },
      s.a.ctx,
      {} as never,
    );
    expect(await listAnswerMemory(s.a.repo)).toHaveLength(2);
  });
});

describe("POST /api/v1/rfis/{id}/reuse (AC 2, AC 6, AC 7)", () => {
  it("pre-fills the identical question with its stored answer and citations, and carries provenance; reuse is audited; no model call", async () => {
    const s = await answeredRound1();
    const { round2, parent } = await followUpRound(s);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await post(s);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(res.status).toBe(201);
    const json = (await res.json()) as ReuseJson;
    expect(json.reused).toBe(true);
    const draft = json.draft;
    expect(draft).toMatchObject({ parent_draft_id: parent.id, origin: "owner" });

    const purpose = draft?.answers.find((x) => x.question_id === round2[0]?.id);
    expect(purpose).toMatchObject({
      text: ANSWER,
      status: "VERIFIED",
      reason_code: null,
      citations: [{ fact_version_id: s.factVersionId, quote: "Total due: USD 4,800.00" }],
      reuse: { reused: true, source_approval_id: s.approvalId },
    });
    expect(Number.isNaN(Date.parse(purpose?.reuse?.approved_on ?? ""))).toBe(false);

    // One word changed (a different question) gets nothing: it keeps the earlier draft's NEEDS_OWNER.
    const endUse = draft?.answers.find((x) => x.question_id === round2[1]?.id);
    expect(endUse).toMatchObject({
      status: "NEEDS_OWNER",
      reason_code: "CANNOT_ANSWER",
      reuse: null,
    });
    expect(draft?.state).toBe("NEEDS_OWNER");

    // The new draft is the latest (a new approval binds to it); the previous one stays.
    expect((await getLatestDraft(s.a.repo, s.a.rfi.id, 2))?.id).toBe(draft?.id);
    const audit = (await listAudit(s.a.repo, 200)).filter((e) => e.action === "answer.reused");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.data).toMatchObject({
      draftId: draft?.id,
      questionId: round2[0]?.id,
      sourceApprovalId: s.approvalId,
    });
    // Still needs a fresh approval: nothing was approved or sent by reusing.
    expect(s.a.responds()).toHaveLength(1);
  });

  it("is idempotent: a second call returns the same draft and audits nothing more", async () => {
    const s = await answeredRound1();
    await followUpRound(s);
    const first = (await (await post(s)).json()) as ReuseJson;
    const again = await post(s);
    expect(again.status).toBe(200);
    expect(((await again.json()) as ReuseJson).draft?.id).toBe(first.draft?.id);
    expect(
      (await listAudit(s.a.repo, 200)).filter((e) => e.action === "answer.reused"),
    ).toHaveLength(1);
  });

  it("different wording gets no reuse and writes no draft", async () => {
    const s = await answeredRound1();
    const { parent } = await followUpRound(s, {
      title: "Purpose of payment",
      description: "Describe the reason for this payment in full.",
    });
    const res = await post(s);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reused: false, draft: null });
    expect((await getLatestDraft(s.a.repo, s.a.rfi.id, 2))?.id).toBe(parent.id);
  });

  it("AC 4: a cited fact superseded by a conflicting newer version is NEEDS_OWNER (REUSE_STALE), not reused", async () => {
    const s = await answeredRound1();
    const { round2 } = await followUpRound(s);
    await insertFactsVersion(s.a.repo, {
      documentId: s.a.documentId,
      source: "model",
      status: "EXTRACTED",
      textLayer: true,
      facts: [fact("Total due: USD 5,100.00")],
    });
    const json = (await (await post(s)).json()) as ReuseJson;
    const purpose = json.draft?.answers.find((x) => x.question_id === round2[0]?.id);
    expect(purpose).toMatchObject({ status: "NEEDS_OWNER", reason_code: "REUSE_STALE", text: "" });
    expect(purpose?.reuse?.source_approval_id).toBe(s.approvalId);
    expect(
      (await listAudit(s.a.repo, 200)).filter((e) => e.action === "answer.reuse_stale"),
    ).toHaveLength(1);
  });

  it("a newer facts version that kept the cited fact is still reusable", async () => {
    const s = await answeredRound1();
    const { round2 } = await followUpRound(s);
    await insertFactsVersion(s.a.repo, {
      documentId: s.a.documentId,
      source: "model",
      status: "EXTRACTED",
      textLayer: true,
      facts: [fact()],
    });
    const json = (await (await post(s)).json()) as ReuseJson;
    const purpose = json.draft?.answers.find((x) => x.question_id === round2[0]?.id);
    expect(purpose).toMatchObject({ status: "VERIFIED", text: ANSWER });
    expect(purpose?.citations[0]?.fact_version_id).not.toBe(s.factVersionId);
  });

  it("nothing is reusable when the respond was never recorded (no memory, no draft)", async () => {
    const s = await answeredRound1({ record: false });
    await followUpRound(s);
    expect(await (await post(s)).json()).toEqual({ reused: false, draft: null });
  });

  it("refuses while no finished draft exists (409-class precondition), and an RFI that is not DRAFT_READY or NEEDS_OWNER", async () => {
    const s = await answeredRound1();
    await followUpRound(s);
    await updateRfi(s.a.repo, s.a.rfi.id, { state: "APPROVED" });
    const res = await post(s);
    expect(res.status).toBe(412);
    expect(
      await listDraftAnswers(s.a.repo, (await getLatestDraft(s.a.repo, s.a.rfi.id, 2))?.id ?? ""),
    ).toHaveLength(2);
  });

  it("another business's session gets 404 and nothing is written; a viewer gets 403", async () => {
    const s = await answeredRound1();
    await followUpRound(s);
    expect((await post(s, cookies.other)).status).toBe(404);
    expect((await post(s, s.viewer)).status).toBe(403);
    expect(
      (await listAudit(s.a.repo, 200)).filter((e) => e.action === "answer.reused"),
    ).toHaveLength(0);
  });

  it("memory is scoped to the counterparty: another counterparty's RFI gets nothing", async () => {
    const s = await answeredRound1();
    const { round2 } = await followUpRound(s);
    const other = await createCounterparty(s.a.repo, { name: "Other Supplier", country: "FR" });
    const payment = await createPayment(s.a.repo, {
      counterpartyId: other.id,
      amount: money(100n, "USD"),
      sourceCurrency: "USD",
      method: "SWIFT",
      reference: `memory-other-${++seq}`,
    });
    await linkRfiToPayment(s.a.repo, s.a.rfi.id, payment.id);
    expect(round2).toHaveLength(2);
    expect(await (await post(s)).json()).toEqual({ reused: false, draft: null });
  });
});
