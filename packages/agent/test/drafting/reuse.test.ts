// M2-06: reuse of a remembered, approved answer. Pure and model-free (AC 7: a transport spy and a fetch
// spy see no call), re-verified against the CURRENT facts (AC 4: a superseded fact or a changed or
// missing document is NEEDS_OWNER with REUSE_STALE), and never a guess.
import type { MemoryEntry, SuppliedDocument, SuppliedFact } from "@carnet/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHarness,
  priorAnswersFor,
  rebindCitation,
  resolveReuse,
  reusedFrom,
  type Transport,
} from "../../src/index";
import { memoryStore } from "../memory-store";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const fact = (over: Partial<SuppliedFact> = {}): SuppliedFact => ({
  id: "fv1#0",
  documentId: "doc-inv",
  key: "total",
  value: "USD 4,800.00",
  parsed: { type: "amount", minor: "480000", currency: "USD" },
  quote: "Total due: USD 4,800.00",
  page: 1,
  ...over,
});
const invoiceDoc: SuppliedDocument = {
  id: "doc-inv",
  kind: "invoice",
  name: "inv.pdf",
  hasUsableFacts: true,
};
const noteDoc: SuppliedDocument = {
  id: "doc-dn",
  kind: "other",
  name: "dn.pdf",
  hasUsableFacts: false,
};

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: "mem-1",
  answerText: "The payment is for invoice total of USD 4,800.00",
  citations: [
    {
      fact_version_id: "fv1#0",
      quote: "Total due: USD 4,800.00",
      document_id: "doc-inv",
      key: "total",
    },
  ],
  attachments: [],
  approvedAt: new Date("2026-11-03T10:00:00.000Z"),
  sourceApprovalId: "appr-1",
  ...over,
});

const text = { id: "q1", answerType: "TEXT" };
const attach = { id: "q2", answerType: "ATTACHMENT" };
const ctx = (facts: SuppliedFact[], documents: SuppliedDocument[] = [invoiceDoc, noteDoc]) => ({
  facts,
  documents,
  documentHashes: new Map([
    ["doc-inv", SHA_A],
    ["doc-dn", SHA_B],
  ]),
});

describe("reuse resolves a remembered answer against the current facts", () => {
  it("reuses it when its cited fact still says the same, with the provenance of the approval", () => {
    const [r] = resolveReuse([text], new Map([["q1", entry()]]), ctx([fact()]));
    expect(r).toMatchObject({
      kind: "reused",
      question_id: "q1",
      verdict: { status: "VERIFIED" },
      provenance: {
        reused: true,
        approved_on: "2026-11-03T10:00:00.000Z",
        source_approval_id: "appr-1",
        memory_id: "mem-1",
      },
    });
    if (r?.kind !== "reused") throw new Error("expected reuse");
    expect(r.answer.text).toBe(entry().answerText);
    expect(r.answer.citations).toEqual([
      { fact_version_id: "fv1#0", quote: "Total due: USD 4,800.00" },
    ]);
  });

  it("returns none for a question without a remembered answer", () => {
    expect(resolveReuse([text], new Map(), ctx([fact()]))).toEqual([
      { kind: "none", question_id: "q1" },
    ]);
  });

  it("keeps the question order", () => {
    const out = resolveReuse([attach, text], new Map([["q1", entry()]]), ctx([fact()]));
    expect(out.map((r) => [r.question_id, r.kind])).toEqual([
      ["q2", "none"],
      ["q1", "reused"],
    ]);
  });

  it("follows a newer facts version that did not change the cited fact (same document, key, quote)", () => {
    const [r] = resolveReuse([text], new Map([["q1", entry()]]), ctx([fact({ id: "fv2#3" })]));
    expect(r?.kind).toBe("reused");
    if (r?.kind === "reused") expect(r.answer.citations[0]?.fact_version_id).toBe("fv2#3");
  });

  it("AC 4: a cited fact superseded by a conflicting newer version is NEEDS_OWNER, REUSE_STALE", () => {
    const changed = fact({
      id: "fv2#0",
      value: "USD 5,100.00",
      parsed: { type: "amount", minor: "510000", currency: "USD" },
      quote: "Total due: USD 5,100.00",
    });
    const [r] = resolveReuse([text], new Map([["q1", entry()]]), ctx([changed]));
    expect(r).toMatchObject({
      kind: "stale",
      verdict: { status: "NEEDS_OWNER", reason: "REUSE_STALE" },
    });
    expect(r?.kind === "stale" && r.verdict.explanation).toMatch(/documents have changed/);
  });

  it("AC 4: the same version id with a different quote is stale", () => {
    const [r] = resolveReuse(
      [text],
      new Map([["q1", entry()]]),
      ctx([fact({ quote: "Total due: USD 4,801.00" })]),
    );
    expect(r?.kind).toBe("stale");
  });

  it("AC 4: a missing fact (document gone, or no longer verified) is stale", () => {
    const [r] = resolveReuse([text], new Map([["q1", entry()]]), ctx([]));
    expect(r).toMatchObject({ kind: "stale", verdict: { reason: "REUSE_STALE" } });
  });

  it("is stale when the documents now dispute the cited fact (CONFLICTING_FACTS underneath)", () => {
    const po = (id: string, doc: string, quote: string) =>
      fact({ id, documentId: doc, key: "purchase_order", value: quote, parsed: null, quote });
    const e = entry({
      answerText: "PO PO-1",
      citations: [
        { fact_version_id: "fa#0", quote: "PO-1", document_id: "doc-a", key: "purchase_order" },
      ],
    });
    const [r] = resolveReuse(
      [text],
      new Map([["q1", e]]),
      ctx(
        [po("fa#0", "doc-a", "PO-1"), po("fb#0", "doc-b", "PO-2")],
        [
          { id: "doc-a", kind: "purchase_order", hasUsableFacts: true },
          { id: "doc-b", kind: "purchase_order", hasUsableFacts: true },
        ],
      ),
    );
    expect(r?.kind).toBe("stale");
  });

  describe("attachments", () => {
    const att = entry({
      answerText: "",
      citations: [],
      attachments: [{ document_id: "doc-dn", sha256: SHA_B }],
    });
    it("reuses an attachment whose document is unchanged", () => {
      const [r] = resolveReuse([attach], new Map([["q2", att]]), ctx([]));
      expect(r).toMatchObject({ kind: "reused" });
      if (r?.kind === "reused") expect(r.answer.document_ids).toEqual(["doc-dn"]);
    });
    it("is stale when the document is gone", () => {
      const c = ctx([], [invoiceDoc]);
      const [r] = resolveReuse([attach], new Map([["q2", att]]), {
        ...c,
        documentHashes: new Map([["doc-inv", SHA_A]]),
      });
      expect(r).toMatchObject({ kind: "stale", verdict: { reason: "REUSE_STALE" } });
    });
    it("is stale when the document's bytes changed (different SHA-256)", () => {
      const c = ctx([]);
      const [r] = resolveReuse([attach], new Map([["q2", att]]), {
        ...c,
        documentHashes: new Map([["doc-dn", SHA_A]]),
      });
      expect(r?.kind).toBe("stale");
    });
  });

  it("an approved answer that cited nothing stays owner-authored, never VERIFIED", () => {
    const own = entry({ answerText: "Our own words", citations: [] });
    const [r] = resolveReuse([text], new Map([["q1", own]]), ctx([]));
    expect(r).toMatchObject({ kind: "reused", verdict: { status: "OWNER_AUTHORED" } });
  });

  it("re-verifies the text: a remembered answer carrying a URL is stale, not reused", () => {
    const [r] = resolveReuse(
      [text],
      new Map([["q1", entry({ answerText: "see https://evil.example/pay" })]]),
      ctx([fact()]),
    );
    expect(r?.kind).toBe("stale");
  });
});

describe("rebindCitation", () => {
  it("is null when nothing matches", () => {
    expect(rebindCitation(entry().citations[0] as MemoryEntry["citations"][number], [])).toBeNull();
  });
});

describe("model drafts and memory", () => {
  it("passes remembered answers to the model as prior answers, only for matched questions", () => {
    expect(
      priorAnswersFor(
        [
          { id: "q1", title: "Purpose of payment" },
          { id: "q2", title: "Other" },
        ],
        new Map([["q1", entry()]]),
      ),
    ).toEqual([{ questionTitle: "Purpose of payment", text: entry().answerText }]);
  });

  it("marks reused_from only when a verified model answer is word for word the remembered one", () => {
    const answer = (text: string) => ({
      question_id: "q1",
      status: "answered" as const,
      text,
      citations: [],
      document_ids: [],
    });
    const verified = { status: "VERIFIED" as const, reason: null, explanation: null, detail: null };
    const matches = new Map([["q1", entry()]]);
    expect(
      reusedFrom(
        [{ question_id: "q1", answer: answer(entry().answerText), verdict: verified }],
        matches,
      ).get("q1")?.source_approval_id,
    ).toBe("appr-1");
    expect(
      reusedFrom(
        [{ question_id: "q1", answer: answer("Different words"), verdict: verified }],
        matches,
      ).size,
    ).toBe(0);
    expect(
      reusedFrom(
        [
          {
            question_id: "q1",
            answer: answer(entry().answerText),
            verdict: {
              ...verified,
              status: "NEEDS_OWNER" as const,
              reason: "NO_CITATIONS" as const,
            },
          },
        ],
        matches,
      ).size,
    ).toBe(0);
  });
});

describe("AC 7: the reuse path makes zero model calls", () => {
  afterEach(() => vi.restoreAllMocks());
  it("neither a harness transport nor fetch is touched", () => {
    const transport = vi.fn() as unknown as Transport;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // A harness exists and could call the model; reuse never receives it.
    createHarness({ store: memoryStore({ agentsEnabled: true }), transport });
    const out = resolveReuse(
      [text, attach],
      new Map([
        ["q1", entry()],
        [
          "q2",
          entry({
            answerText: "",
            citations: [],
            attachments: [{ document_id: "doc-dn", sha256: SHA_B }],
          }),
        ],
      ]),
      ctx([fact()]),
    );
    expect(out.map((r) => r.kind)).toEqual(["reused", "reused"]);
    expect(transport).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
