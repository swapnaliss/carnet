// M2-06: answer memory. Written only from a CONSUMED approval whose respond attempt is CONFIRMED (never from
// a draft, a rejected, expired or not-yet-confirmed approval), immutable, matched on the exact fingerprint
// only, newest approval wins, never across businesses or counterparties.
import { readFileSync } from "node:fs";
import {
  type ApprovalId,
  type AttemptId,
  type BusinessId,
  type CounterpartyId,
  type DocumentId,
  type ExtractedFact,
  money,
  type RfiAnswerSubject,
  type RfiId,
  type UserId,
} from "@carnet/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { insertFactsVersion } from "../src/repos/document-facts";
import {
  consumeApproval,
  createApproval,
  createCounterparty,
  createPayment,
  createUser,
  endApproval,
  findReusable,
  findReusableForRound,
  getRfi,
  insertRfi,
  insertRfiQuestions,
  listRfiQuestions,
  type Rfi,
  recordApprovedAnswers,
  repoCtx,
  storeDocument,
  updateAttemptStatus,
  updateRfi,
} from "../src/repos/index";
import { createBusiness } from "../src/repos/system";
import { sqlStateOf, useTestDatabase, withClient } from "./harness";

const db = useTestDatabase({ prefix: "answer_memory" });
const PERMISSION_DENIED = "42501";
const RESTRICT_VIOLATION = "23001";

const invoiceBytes = new Uint8Array(
  readFileSync(new URL("../../../fixtures/dataset/inv-harbor-001.pdf", import.meta.url)),
);
const QUESTION = "Please describe the purpose of this payment.";
// What is fingerprinted: the English title, a newline, the English description (approvalQuestionText).
const FULL = `Purpose of payment\n${QUESTION}`;
const PROOF = "Proof of delivery\nProvide the delivery note.";

const fact = (): ExtractedFact => ({
  key: "total",
  value: "USD 4,800.00",
  parsed: { type: "amount", minor: "480000", currency: "USD" },
  quote: "Total due: USD 4,800.00",
  page: 1,
  quote_verified: true,
  needs_confirmation: false,
  issues: [],
});

interface World {
  business: BusinessId;
  user: UserId;
  counterparty: CounterpartyId;
  rfi: Rfi;
  /** Airwallex question id -> Carnet question id (round 1). */
  q: { purpose: string; proof: string };
  factVersionId: string;
  document: DocumentId;
  sha256: string;
}

let n = 0;
async function world(
  options: { orphan?: boolean; name?: string; question?: string } = {},
): Promise<World> {
  n += 1;
  const business = await createBusiness(db().app.db, { name: options.name ?? `memory-co-${n}` });
  const ctx = repoCtx(db().app.db, business);
  const user = (await createUser(ctx, { email: `owner${n}@memory.test`, role: "owner" })).id;
  const counterparty = (await createCounterparty(ctx, { name: "Rhein Supplies", country: "DE" }))
    .id;
  const payment = await createPayment(ctx, {
    counterpartyId: counterparty,
    amount: money(480000n, "USD"),
    sourceCurrency: "USD",
    method: "SWIFT",
    reference: `ref-${n}`,
  });
  const stored = await storeDocument(ctx, {
    kind: "invoice",
    filename: "inv.pdf",
    mime: "application/pdf",
    bytes: invoiceBytes,
  });
  const facts = await insertFactsVersion(ctx, {
    documentId: stored.document.id,
    source: "model",
    status: "EXTRACTED",
    textLayer: true,
    facts: [fact()],
  });
  const rfi = await insertRfi(ctx, {
    airwallexRfiId: `awx-rfi-${n}`,
    type: "TRANSACTION",
    subType: null,
    airwallexStatus: "ACTION_REQUIRED",
    airwallexUpdatedAt: new Date("2026-11-03T09:57:38Z"),
    airwallexAnsweredRequests: 0,
    state: "ANSWER_SUBMITTING",
    round: 1,
    expiresAt: null,
    paymentId: options.orphan ? null : payment.id,
    orphanReason: options.orphan ? "NO_SOURCES" : null,
    linkedBy: options.orphan ? null : "owner",
    sourceKey: null,
    conflict: false,
  });
  const base = {
    round: 1,
    comment: null,
    sources: [],
    reopened: false,
    needsDrafting: true,
  };
  await insertRfiQuestions(ctx, rfi.id, [
    {
      ...base,
      airwallexQuestionId: "aq-purpose",
      position: 0,
      title: { en: "Purpose of payment", zh: null },
      description: { en: options.question ?? QUESTION, zh: null },
      answerType: "TEXT",
    },
    {
      ...base,
      airwallexQuestionId: "aq-proof",
      position: 1,
      title: { en: "Proof of delivery", zh: null },
      description: { en: "Provide the delivery note.", zh: null },
      answerType: "ATTACHMENT",
    },
  ]);
  const questions = await listRfiQuestions(ctx, rfi.id, 1);
  const id = (a: string) =>
    (questions.find((x) => x.airwallexQuestionId === a) as { id: string }).id;
  return {
    business,
    user,
    counterparty,
    rfi,
    q: { purpose: id("aq-purpose"), proof: id("aq-proof") },
    factVersionId: `${facts.version.id}#0`,
    document: stored.document.id,
    sha256: stored.document.sha256,
  };
}

const setFlag = (enabled: boolean) =>
  withClient(db().migrationUrl, (c) =>
    c.query("UPDATE system_flags SET execution_enabled = $1 WHERE id = 1", [enabled]),
  );

interface Approved {
  approvalId: ApprovalId;
  attemptId: AttemptId | null;
}

/** An approval of both questions, consumed (default) with a respond attempt resolved as `attempt`. */
async function approve(
  w: World,
  over: {
    text?: string;
    consume?: boolean;
    end?: "REJECTED" | "EXPIRED";
    attempt?: "CONFIRMED" | "SENT_TO_AIRWALLEX" | "UNKNOWN" | "REJECTED";
    factVersionIds?: string[];
  } = {},
): Promise<Approved> {
  const ctx = repoCtx(db().app.db, w.business);
  const subject: RfiAnswerSubject = {
    kind: "rfi_answer",
    businessId: w.business,
    approverId: w.user,
    nonce: crypto.randomUUID(),
    rfiId: w.rfi.id,
    rfiUpdatedAt: w.rfi.airwallexUpdatedAt.toISOString(),
    draftId: crypto.randomUUID(),
    promptVersion: "draft@test",
    questions: [
      { id: "aq-purpose", text: `Purpose of payment\n${QUESTION}` },
      { id: "aq-proof", text: "Proof of delivery\nProvide the delivery note." },
    ],
    answers: [
      {
        questionId: "aq-purpose",
        type: "TEXT",
        text: over.text ?? "Payment of invoice total USD 4,800.00",
        attachments: [],
        factVersionIds: over.factVersionIds ?? [w.factVersionId],
      },
      {
        questionId: "aq-proof",
        type: "ATTACHMENT",
        text: "",
        attachments: [{ documentId: w.document, sha256: w.sha256 }],
        factVersionIds: [],
      },
    ],
  };
  const hash = "d".repeat(63) + (n % 10);
  const approval = await createApproval(ctx, {
    kind: "rfi_answer",
    subjectRef: w.rfi.id,
    hash,
    nonce: subject.nonce,
    approverId: w.user,
    expiresAt: new Date(Date.now() + 30 * 60_000),
    shownSnapshot: { version: 1, subject, attachments: [] },
  });
  if (over.end) {
    await endApproval(
      ctx,
      approval.id,
      over.end,
      over.end === "EXPIRED" ? "TTL" : "REJECTED_BY_USER",
    );
    return { approvalId: approval.id, attemptId: null };
  }
  if (over.consume === false) return { approvalId: approval.id, attemptId: null };
  const consumed = await consumeApproval(ctx, { approvalId: approval.id, expectedHash: hash });
  if (consumed.outcome !== "consumed") throw new Error(`consume refused: ${consumed.reason}`);
  await updateAttemptStatus(ctx, consumed.attempt.id, over.attempt ?? "CONFIRMED");
  return { approvalId: approval.id, attemptId: consumed.attempt.id };
}

const rowCount = async (w: World): Promise<number> =>
  withClient(db().migrationUrl, async (c) =>
    Number(
      (await c.query("SELECT count(*) FROM answer_memory WHERE business_id = $1", [w.business]))
        .rows[0].count,
    ),
  );

const record = (w: World, a: Approved) =>
  recordApprovedAnswers(repoCtx(db().app.db, w.business), {
    rfiId: w.rfi.id,
    approvalId: a.approvalId,
    attemptId: a.attemptId,
  });

beforeAll(async () => {
  await setFlag(true);
});

describe("what is written, and when (AC 3)", () => {
  it("writes nothing for a draft: memory only has rows after an approval is recorded", async () => {
    const w = await world();
    expect(await rowCount(w)).toBe(0);
  });

  it("writes one row per answered question from a consumed approval with a CONFIRMED respond", async () => {
    const w = await world();
    const a = await approve(w);
    expect(await record(w, a)).toEqual({ recorded: 2, skipped: null });
    expect(await rowCount(w)).toBe(2);
    const ctx = repoCtx(db().app.db, w.business);
    const hit = await findReusable(ctx, w.counterparty, FULL, "TEXT");
    expect(hit).toMatchObject({
      answerText: "Payment of invoice total USD 4,800.00",
      sourceApprovalId: a.approvalId,
    });
    expect(hit?.citations).toEqual([
      {
        fact_version_id: w.factVersionId,
        quote: "Total due: USD 4,800.00",
        document_id: w.document,
        key: "total",
      },
    ]);
    expect(hit?.approvedAt).toBeInstanceOf(Date);
    const att = await findReusable(ctx, w.counterparty, PROOF, "ATTACHMENT");
    expect(att?.attachments).toEqual([{ document_id: w.document, sha256: w.sha256 }]);
  });

  it("is idempotent: a redelivered event writes nothing twice", async () => {
    const w = await world();
    const a = await approve(w);
    await record(w, a);
    expect(await record(w, a)).toEqual({ recorded: 0, skipped: null });
    expect(await rowCount(w)).toBe(2);
  });

  it("writes nothing for an approval that was never consumed", async () => {
    const w = await world();
    expect(await record(w, await approve(w, { consume: false }))).toMatchObject({
      recorded: 0,
      skipped: "APPROVAL_NOT_CONSUMED",
    });
    expect(await rowCount(w)).toBe(0);
  });

  it("writes nothing for a rejected or an expired approval", async () => {
    const w = await world();
    for (const end of ["REJECTED", "EXPIRED"] as const) {
      expect(await record(w, await approve(w, { end }))).toMatchObject({
        recorded: 0,
        skipped: "APPROVAL_NOT_CONSUMED",
      });
    }
    expect(await rowCount(w)).toBe(0);
  });

  it("writes nothing while the respond attempt is not CONFIRMED (sent, unknown, rejected)", async () => {
    const w = await world();
    for (const attempt of ["SENT_TO_AIRWALLEX", "UNKNOWN", "REJECTED"] as const) {
      expect(await record(w, await approve(w, { attempt }))).toMatchObject({
        recorded: 0,
        skipped: "ATTEMPT_NOT_CONFIRMED",
      });
    }
    expect(await rowCount(w)).toBe(0);
  });

  it("without an attempt id, requires the RFI to be ANSWERED", async () => {
    const w = await world();
    const a = await approve(w);
    const ctx = repoCtx(db().app.db, w.business);
    const input = { rfiId: w.rfi.id, approvalId: a.approvalId };
    expect(await recordApprovedAnswers(ctx, input)).toMatchObject({ skipped: "RFI_NOT_ANSWERED" });
    await updateRfi(ctx, w.rfi.id, { state: "ANSWERED" });
    expect(await recordApprovedAnswers(ctx, input)).toMatchObject({ recorded: 2 });
  });

  it("an orphan RFI has no counterparty to scope memory to: nothing is written", async () => {
    const w = await world({ orphan: true });
    expect(await record(w, await approve(w))).toMatchObject({ skipped: "NO_COUNTERPARTY" });
    expect(await rowCount(w)).toBe(0);
  });

  it("does not remember an answer whose cited fact cannot be found again", async () => {
    const w = await world();
    const a = await approve(w, { factVersionIds: [`${crypto.randomUUID()}#0`] });
    expect(await record(w, a)).toEqual({ recorded: 1, skipped: null }); // the attachment answer only
    const ctx = repoCtx(db().app.db, w.business);
    expect(await findReusable(ctx, w.counterparty, FULL, "TEXT")).toBeNull();
  });

  it("another business's approval cannot be recorded through this business", async () => {
    const w = await world();
    const other = await world();
    const a = await approve(other);
    const ctx = repoCtx(db().app.db, w.business);
    expect(
      await recordApprovedAnswers(ctx, {
        rfiId: other.rfi.id,
        approvalId: a.approvalId,
        attemptId: a.attemptId,
      }),
    ).toMatchObject({ recorded: 0, skipped: "APPROVAL_NOT_FOUND" });
  });
});

describe("lookup (AC 2, AC 5)", () => {
  it("matches the same text in another case, spacing and punctuation; a changed word or digit gives nothing", async () => {
    const w = await world();
    await record(w, await approve(w));
    const ctx = repoCtx(db().app.db, w.business);
    const find = (text: string, type = "TEXT") => findReusable(ctx, w.counterparty, text, type);
    expect(
      await find("  PURPOSE of payment\n  PLEASE describe   the purpose of this payment "),
    ).not.toBeNull();
    expect(
      await find("purpose of payment please describe the purpose of this payment!!"),
    ).not.toBeNull();
    expect(
      await find("Purpose of payment\nPlease describe the purpose of this transfer."),
    ).toBeNull();
    expect(await find(`${FULL} in 2 lines.`)).toBeNull();
    expect(await find(FULL, "ATTACHMENT")).toBeNull();
  });

  it("a follow-up round with the same question text returns the stored answer; one word changed returns nothing", async () => {
    const w = await world();
    await record(w, await approve(w));
    const ctx = repoCtx(db().app.db, w.business);
    const followUp = {
      round: 2,
      comment: null,
      sources: [],
      reopened: false,
      needsDrafting: true,
      answerType: "TEXT",
    };
    await insertRfiQuestions(ctx, w.rfi.id, [
      {
        ...followUp,
        airwallexQuestionId: "aq2-same",
        position: 0,
        title: { en: "PURPOSE of payment", zh: null },
        description: { en: QUESTION.toUpperCase(), zh: null },
      },
      {
        ...followUp,
        airwallexQuestionId: "aq2-changed",
        position: 1,
        title: { en: "Purpose of payment", zh: null },
        description: { en: "Please describe the reason of this payment.", zh: null },
      },
    ]);
    const rfi = (await getRfi(ctx, w.rfi.id)) as Rfi;
    const { questions, matches } = await findReusableForRound(ctx, rfi, 2);
    const same = questions.find((q) => q.airwallexQuestionId === "aq2-same");
    const changed = questions.find((q) => q.airwallexQuestionId === "aq2-changed");
    expect(matches.get(same?.id as string)?.answerText).toBe(
      "Payment of invoice total USD 4,800.00",
    );
    expect(matches.get(same?.id as string)?.citations).toHaveLength(1);
    expect(matches.has(changed?.id as string)).toBe(false);
  });

  it("returns the most recent approval when several exist", async () => {
    const w = await world();
    await record(w, await approve(w, { text: "First answer" }));
    // The first RFI is answered; a later approval of the same RFI is a later round of the same question.
    const second = await approve(w, { text: "Second answer" });
    await record(w, second);
    const ctx = repoCtx(db().app.db, w.business);
    expect((await findReusable(ctx, w.counterparty, FULL, "TEXT"))?.answerText).toBe(
      "Second answer",
    );
  });

  it("never matches across businesses", async () => {
    const a = await world({ question: QUESTION });
    const b = await world({ question: QUESTION });
    await record(a, await approve(a));
    const ctxB = repoCtx(db().app.db, b.business);
    expect(await findReusable(ctxB, b.counterparty, FULL, "TEXT")).toBeNull();
    // Even with the other business's counterparty id: the business scope is the tenant's own.
    expect(await findReusable(ctxB, a.counterparty, FULL, "TEXT")).toBeNull();
  });

  it("never matches across counterparties of one business", async () => {
    const w = await world();
    await record(w, await approve(w));
    const ctx = repoCtx(db().app.db, w.business);
    const other = (await createCounterparty(ctx, { name: "Other Supplier", country: "FR" })).id;
    expect(await findReusable(ctx, other, FULL, "TEXT")).toBeNull();
    expect(await findReusable(ctx, w.counterparty, FULL, "TEXT")).not.toBeNull();
  });
});

describe("immutability", () => {
  it("the app role cannot UPDATE or DELETE, and a trigger refuses both for the owner", async () => {
    const w = await world();
    await record(w, await approve(w));
    for (const sql of [
      "UPDATE answer_memory SET answer_text = 'changed'",
      "DELETE FROM answer_memory",
    ]) {
      expect(await sqlStateOf(db().appUrl, sql), `app: ${sql}`).toBe(PERMISSION_DENIED);
      expect(await sqlStateOf(db().migrationUrl, sql), `migrator: ${sql}`).toBe(RESTRICT_VIOLATION);
    }
  });

  it("refuses a malformed fingerprint", async () => {
    const w = await world();
    const a = await approve(w);
    const sql = `INSERT INTO answer_memory (business_id, counterparty_id, fingerprint, fp_version, answer_type, question_id, answer_text, citations, attachments, source_approval_id, approved_at)
      VALUES ('${w.business}', '${w.counterparty}', 'nothex', 1, 'TEXT', '${w.q.purpose}', 'x', '[]', '[]', '${a.approvalId}', now())`;
    expect(await sqlStateOf(db().migrationUrl, sql)).toBe("23514");
  });
});
