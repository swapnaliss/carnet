// M2-05: drafts and draft_answers. Immutable (no repository update path, no app-role UPDATE or DELETE, a
// trigger for every role), an owner edit inserts a new draft that goes through the same verifier, the
// evidence view offers only usable facts, and the stuck-DRAFTING lookup finds RFIs without a draft.
import { readFileSync } from "node:fs";
import {
  ANSWER_STATUSES,
  type BusinessId,
  type DocumentId,
  DRAFT_ORIGINS,
  DRAFT_STATES,
  type ExtractedFact,
  needsOwner,
  type RfiId,
} from "@carnet/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { insertFactsVersion } from "../src/repos/document-facts";
import { listStuckDraftingRfis } from "../src/repos/draft-sweep";
import * as draftsRepo from "../src/repos/drafts";
import {
  createOwnerDraft,
  getDraft,
  getLatestDraft,
  insertDraft,
  listDraftAnswers,
  listDrafts,
  loadDraftingEvidence,
} from "../src/repos/drafts";
import { repoCtx, storeDocument } from "../src/repos/index";
import { insertRfi, insertRfiQuestions, listRfiQuestions, updateRfi } from "../src/repos/rfis";
import { createBusiness } from "../src/repos/system";
import { createUser } from "../src/repos/users";
import {
  DRAFT_ANSWER_STATUS_VALUES,
  DRAFT_ORIGIN_VALUES,
  DRAFT_STATE_VALUES,
} from "../src/schema/drafts";
import { sqlStateOf, useTestDatabase } from "./harness";

const db = useTestDatabase();
const PERMISSION_DENIED = "42501";
const RESTRICT_VIOLATION = "23001";

const bytes = new Uint8Array(
  readFileSync(new URL("../../../fixtures/dataset/inv-harbor-001.pdf", import.meta.url)),
);
const scanBytes = new Uint8Array(
  readFileSync(new URL("../../../fixtures/dataset/inv-lakeside-001.pdf", import.meta.url)),
);

const fact = (over: Partial<ExtractedFact> = {}): ExtractedFact => ({
  key: "total",
  value: "USD 4,800.00",
  parsed: { type: "amount", minor: "480000", currency: "USD" },
  quote: "Total due: USD 4,800.00",
  page: 1,
  quote_verified: true,
  needs_confirmation: false,
  issues: [],
  ...over,
});

let business: BusinessId;
let rfiId: RfiId;
let doc: DocumentId;
let scan: DocumentId;
let q1: string;
let q2: string;
let owner: string;
let factsVersionId: string;

beforeAll(async () => {
  const { app } = db();
  business = await createBusiness(app.db, { name: "drafts-co" });
  const ctx = repoCtx(app.db, business);
  owner = (await createUser(ctx, { email: "owner@drafts.example.com", role: "owner" })).id;
  doc = (
    await storeDocument(ctx, {
      kind: "invoice",
      filename: "inv.pdf",
      mime: "application/pdf",
      bytes,
    })
  ).document.id;
  scan = (
    await storeDocument(ctx, {
      kind: "invoice",
      filename: "scan.pdf",
      mime: "application/pdf",
      bytes: scanBytes,
    })
  ).document.id;
  const v = await insertFactsVersion(ctx, {
    documentId: doc,
    source: "model",
    status: "EXTRACTED",
    textLayer: true,
    facts: [
      fact(),
      fact({
        key: "buyer",
        value: "Northwind Studio Ltd",
        parsed: { type: "text", text: "Northwind Studio Ltd" },
        quote: "Bill to: Northwind Studio Ltd",
      }),
      fact({ key: "supplier", quote_verified: false, issues: ["quote_not_found"] }),
    ],
  });
  factsVersionId = v.version.id;
  await insertFactsVersion(ctx, {
    documentId: scan,
    source: "model",
    status: "EXTRACTED",
    textLayer: false,
    facts: [fact({ quote_verified: false, needs_confirmation: true, issues: ["no_text_layer"] })],
  });
  const rfi = await insertRfi(ctx, {
    airwallexRfiId: "rfi-drafts-1",
    type: "TRANSACTION",
    subType: null,
    airwallexStatus: "ACTION_REQUIRED",
    airwallexUpdatedAt: new Date("2026-11-03T09:57:38Z"),
    airwallexAnsweredRequests: 0,
    state: "DRAFTING",
    round: 1,
    expiresAt: null,
    paymentId: null,
    orphanReason: "NO_SOURCES",
    linkedBy: null,
    sourceKey: null,
    conflict: false,
  });
  rfiId = rfi.id;
  const base = {
    round: 1,
    position: 0,
    title: { en: "Purpose", zh: null },
    description: { en: "Why?", zh: null },
    comment: null,
    answerType: "TEXT",
    sources: [],
    reopened: false,
    needsDrafting: true,
  };
  await insertRfiQuestions(ctx, rfiId, [
    { ...base, airwallexQuestionId: "aq-1" },
    { ...base, airwallexQuestionId: "aq-2", position: 1, answerType: "ATTACHMENT" },
  ]);
  const qs = await listRfiQuestions(ctx, rfiId, 1);
  q1 = qs[0]?.id ?? "";
  q2 = qs[1]?.id ?? "";
});

const ctx = () => repoCtx(db().app.db, business);
const GOOD = "Payment of USD 4,800.00 to Northwind Studio Ltd.";

describe("insertDraft", () => {
  it("stores the draft with its answers and the roll-up, idempotently per key", async () => {
    const a = await insertDraft(ctx(), {
      rfiId,
      round: 1,
      origin: "model",
      draftKey: "job-1",
      promptVersion: "pv",
      model: "claude-sonnet-5-5",
      inputHash: "h",
      injectionFlags: [{ kind: "instruction_phrase", rule: "r", match: "m" }],
      answers: [
        {
          questionId: q1,
          text: GOOD,
          citations: [{ fact_version_id: `${factsVersionId}#0`, quote: "Total due: USD 4,800.00" }],
          documentIds: [],
          verdict: { status: "VERIFIED", reason: null, explanation: null, detail: null },
        },
        {
          questionId: q2,
          text: "",
          citations: [],
          documentIds: [],
          verdict: needsOwner("CANNOT_ANSWER"),
        },
      ],
    });
    expect(a.inserted).toBe(true);
    expect(a.draft.state).toBe("NEEDS_OWNER");
    expect(a.draft.blocking).toMatchObject([{ question_id: q2, reason: "CANNOT_ANSWER" }]);
    expect(a.draft.injectionFlags).toHaveLength(1);
    const answers = await listDraftAnswers(ctx(), a.draft.id);
    expect(answers.map((x) => x.status).sort()).toEqual(["NEEDS_OWNER", "VERIFIED"]);

    const again = await insertDraft(ctx(), {
      rfiId,
      round: 1,
      origin: "model",
      draftKey: "job-1",
      answers: [],
    });
    expect(again.inserted).toBe(false);
    expect(again.draft.id).toBe(a.draft.id);
    expect(await listDraftAnswers(ctx(), a.draft.id)).toHaveLength(2);
  });
});

describe("AC6: editing creates a new draft; originals are immutable", () => {
  it("the repository has no update or delete path", () => {
    expect(
      Object.keys(draftsRepo).filter((k) => /update|patch|delete|remove|set[A-Z]/.test(k)),
    ).toEqual([]);
  });

  it("an owner edit inserts a new draft id and leaves the original rows unchanged", async () => {
    const [orig] = await listDrafts(ctx(), rfiId, 1);
    if (!orig) throw new Error("no draft");
    const before = await listDraftAnswers(ctx(), orig.id);
    const edit = await createOwnerDraft(ctx(), {
      rfiId,
      round: 1,
      parentDraftId: orig.id,
      draftKey: "edit-1",
      userId: owner,
      answers: [
        {
          questionId: q1,
          text: GOOD,
          citations: [
            { fact_version_id: `${factsVersionId}#0`, quote: "Total due: USD 4,800.00" },
            { fact_version_id: `${factsVersionId}#1`, quote: "Bill to: Northwind Studio Ltd" },
          ],
        },
        { questionId: q2, text: "", documentIds: [doc] },
      ],
    });
    expect(edit?.inserted).toBe(true);
    expect(edit?.draft.id).not.toBe(orig.id);
    expect(edit?.draft.parentDraftId).toBe(orig.id);
    expect(edit?.draft.origin).toBe("owner");
    expect(edit?.draft.state).toBe("DRAFT_READY");
    expect(await listDraftAnswers(ctx(), orig.id)).toEqual(before);
    expect((await getDraft(ctx(), orig.id))?.state).toBe("NEEDS_OWNER");
    expect((await getLatestDraft(ctx(), rfiId, 1))?.id).toBe(edit?.draft.id);
  });

  it("owner text citing a wrong figure is rejected by the verifier", async () => {
    const edit = await createOwnerDraft(ctx(), {
      rfiId,
      round: 1,
      parentDraftId: null,
      draftKey: "edit-wrong",
      userId: owner,
      answers: [
        {
          questionId: q1,
          text: "Payment of USD 5,800.00 to Northwind Studio Ltd.",
          citations: [{ fact_version_id: `${factsVersionId}#0`, quote: "Total due: USD 4,800.00" }],
        },
        { questionId: q2, text: "", documentIds: [scan] },
      ],
    });
    const answers = await listDraftAnswers(ctx(), edit?.draft.id ?? "");
    const byQ = new Map(answers.map((a) => [a.questionId, a]));
    expect(byQ.get(q1)?.reasonCode).toBe("UNSUPPORTED_AMOUNT");
    expect(byQ.get(q2)?.reasonCode).toBe("ATTACHMENT_NOT_VERIFIED");
    expect(edit?.draft.state).toBe("NEEDS_OWNER");
  });

  it("text with no citations is accepted only when marked owner-authored", async () => {
    const plain = await createOwnerDraft(ctx(), {
      rfiId,
      round: 1,
      parentDraftId: null,
      draftKey: "edit-plain",
      userId: owner,
      answers: [
        { questionId: q1, text: "We buy brochures." },
        { questionId: q2, text: "", documentIds: [doc] },
      ],
    });
    expect(
      (await listDraftAnswers(ctx(), plain?.draft.id ?? "")).find((a) => a.questionId === q1)
        ?.reasonCode,
    ).toBe("NO_CITATIONS");
    const marked = await createOwnerDraft(ctx(), {
      rfiId,
      round: 1,
      parentDraftId: null,
      draftKey: "edit-marked",
      userId: owner,
      answers: [
        { questionId: q1, text: "We buy brochures.", ownerAuthored: true },
        { questionId: q2, text: "", documentIds: [doc] },
      ],
    });
    expect(
      (await listDraftAnswers(ctx(), marked?.draft.id ?? "")).find((a) => a.questionId === q1)
        ?.status,
    ).toBe("OWNER_AUTHORED");
    expect(marked?.draft.state).toBe("DRAFT_READY");
  });

  it.each([
    ["UPDATE of text", "UPDATE draft_answers SET text = 'changed'"],
    ["UPDATE of status", "UPDATE draft_answers SET status = 'VERIFIED'"],
    ["DELETE of answers", "DELETE FROM draft_answers"],
    ["UPDATE of a draft", "UPDATE drafts SET state = 'DRAFT_READY'"],
    ["DELETE of drafts", "DELETE FROM drafts"],
  ])("as the app role, %s fails with a permission error", async (_c, sql) => {
    expect(await sqlStateOf(db().appUrl, sql)).toBe(PERMISSION_DENIED);
  });

  it.each([
    ["UPDATE draft_answers SET text = 'changed'"],
    ["DELETE FROM draft_answers"],
    ["UPDATE drafts SET state = 'DRAFT_READY'"],
    ["DELETE FROM drafts"],
  ])("even the owning migration role cannot (trigger): %s", async (sql) => {
    expect(await sqlStateOf(db().migrationUrl, sql)).toBe(RESTRICT_VIOLATION);
  });
});

describe("loadDraftingEvidence", () => {
  it("offers only usable facts, with ids that name the version and index", async () => {
    const ev = await loadDraftingEvidence(ctx());
    expect(ev.facts.map((f) => f.id).sort()).toEqual([
      `${factsVersionId}#0`,
      `${factsVersionId}#1`,
    ]);
    expect(ev.documents.find((d) => d.id === doc)?.hasUsableFacts).toBe(true);
    expect(ev.documents.find((d) => d.id === scan)?.hasUsableFacts).toBe(false);
  });
});

describe("listStuckDraftingRfis", () => {
  it("finds a DRAFTING RFI only while its current round has no draft", async () => {
    const c = ctx();
    const stuck = await insertRfi(c, {
      airwallexRfiId: "rfi-stuck",
      type: "TRANSACTION",
      subType: null,
      airwallexStatus: "ACTION_REQUIRED",
      airwallexUpdatedAt: new Date("2026-11-03T09:57:38Z"),
      airwallexAnsweredRequests: 0,
      state: "DRAFTING",
      round: 1,
      expiresAt: null,
      paymentId: null,
      orphanReason: "NO_SOURCES",
      linkedBy: null,
      sourceKey: null,
      conflict: false,
    });
    const future = new Date(Date.now() + 60_000);
    const found = await listStuckDraftingRfis(db().app.db, future);
    expect(found.map((r) => r.rfiId)).toContain(stuck.id);
    expect(found.map((r) => r.rfiId)).not.toContain(rfiId); // has drafts
    expect(await listStuckDraftingRfis(db().app.db, new Date(Date.now() - 3_600_000))).toEqual([]);
    await updateRfi(c, stuck.id, { state: "DRAFT_READY" });
    expect((await listStuckDraftingRfis(db().app.db, future)).map((r) => r.rfiId)).not.toContain(
      stuck.id,
    );
  });
});

describe("mirrors", () => {
  it("schema value lists equal the domain's", () => {
    expect([...DRAFT_ORIGIN_VALUES]).toEqual([...DRAFT_ORIGINS]);
    expect([...DRAFT_STATE_VALUES]).toEqual([...DRAFT_STATES]);
    expect([...DRAFT_ANSWER_STATUS_VALUES]).toEqual([...ANSWER_STATUSES]);
  });
});
