import { describe, expect, it } from "vitest";
import type { AnswerDto, CitationDto, HoldView, QuestionDto } from "@/server/hold";
import {
  approveGate,
  buildApproveBody,
  claimsOf,
  countQuestions,
  needsOwnerKey,
  shouldPoll,
  snippetGroups,
  splitSentences,
} from "./view";

const doc = {
  id: "d1",
  filename: "inv.pdf",
  kind: "invoice",
  mime: "application/pdf",
  size: 10,
  sha256: "ab".repeat(32),
};
const cit = (id: string, value: string, quote: string): CitationDto => ({
  fact_version_id: id,
  document: doc,
  key: "k",
  value,
  quote,
  page: 1,
  verification: "quote_verified",
});
const answer = (over: Partial<AnswerDto> = {}): AnswerDto => ({
  status: "VERIFIED",
  reason_code: null,
  explanation: null,
  detail: null,
  text: "Invoice RD-1 is for EUR 7,200.00. It is from Rheinblick.",
  citations: [
    cit("v#0", "RD-1", "Invoice number: RD-1"),
    cit("v#1", "EUR 7200.00", "Total EUR 7200.00"),
  ],
  unresolved_citations: [],
  documents: [],
  reuse: null,
  ...over,
});
const question = (id: string, a: AnswerDto | null, type = "TEXT"): QuestionDto => ({
  id,
  airwallex_question_id: `aw-${id}`,
  position: 0,
  title: `T${id}`,
  description: "",
  answer_type: type,
  reopened: false,
  follow_up: null,
  answer: a,
});
const view = (over: Partial<HoldView> = {}): HoldView => ({
  server_time: "2026-11-09T10:00:00.000Z",
  role: "owner",
  rfi: {
    id: "r" as HoldView["rfi"]["id"],
    airwallex_rfi_id: "aw",
    type: "TRANSACTION",
    state: "DRAFT_READY",
    round: 1,
    airwallex_status: "ACTION_REQUIRED",
    airwallex_updated_at: "2026-11-09T09:00:00.000Z",
    expires_at: "2026-11-10T10:00:00.000Z",
    expiring_soon: false,
    expired: false,
    payment_id: null,
    orphan_reason: null,
    linked_by: null,
    conflict: false,
    created_at: "2026-11-09T09:00:00.000Z",
  },
  payment: {
    id: "p",
    counterparty: "Rheinblick",
    reference: "R",
    amount: { amount: "1.00", currency: "EUR" },
    transfer_status: "PROCESSING",
    view: "PROCESSING",
    held: true,
  },
  questions: [question("1", answer()), question("2", answer())],
  draft: {
    id: "dr",
    state: "DRAFT_READY",
    origin: "model",
    prompt_version: "pv",
    created_at: "x",
    injection_flagged: false,
  },
  approval: null,
  attempt: null,
  execution_enabled: true,
  approval_ttl_minutes: 30,
  documents: [],
  ...over,
});
const now = Date.parse("2026-11-09T10:00:00.000Z");

describe("rfi-ui claims", () => {
  it("splits sentences and matches figures across formats", () => {
    expect(splitSentences("A is B. C is D.")).toHaveLength(2);
    const claims = claimsOf(answer());
    expect(claims[0]?.citations.map((c) => c.fact_version_id)).toEqual(["v#0", "v#1"]);
    expect(claims[1]?.n).toBe(0);
    expect(snippetGroups(claims, answer())).toHaveLength(2);
  });
});

describe("rfi-ui approve gate", () => {
  it("enables approve when every question is answered", () => {
    expect(approveGate(view(), { now, lastSuccessAt: now }).enabled).toBe(true);
  });
  it("blocks an unlinked request until it is linked", () => {
    expect(approveGate(view({ payment: null }), { now, lastSuccessAt: now }).reason).toBe(
      "UNLINKED",
    );
  });
  it("blocks on NEEDS_OWNER with the blocking position", () => {
    const v = view({
      questions: [
        question("1", answer()),
        question(
          "2",
          answer({ status: "NEEDS_OWNER", reason_code: "CANNOT_ANSWER", text: "", citations: [] }),
        ),
      ],
    });
    const g = approveGate(v, { now, lastSuccessAt: now });
    expect(g).toMatchObject({ enabled: false, reason: "NEEDS_OWNER", blocking: [2] });
    expect(countQuestions(v)).toMatchObject({ ready: 1, needs: 1 });
  });
  it("blocks on stale data, kill switch, viewer, expiry and closeness to expiry", () => {
    expect(approveGate(view(), { now, lastSuccessAt: now - 61_000 }).reason).toBe("STALE_DATA");
    expect(
      approveGate(view({ execution_enabled: false }), { now, lastSuccessAt: now }).reason,
    ).toBe("KILL_SWITCH");
    expect(approveGate(view({ role: "viewer" }), { now, lastSuccessAt: now }).reason).toBe(
      "VIEWER",
    );
    const v = view();
    expect(
      approveGate(
        { ...v, rfi: { ...v.rfi, state: "EXPIRED", expired: true } },
        { now, lastSuccessAt: now },
      ).reason,
    ).toBe("EXPIRED");
    expect(
      approveGate(
        { ...v, rfi: { ...v.rfi, expires_at: "2026-11-09T10:03:00.000Z" } },
        { now, lastSuccessAt: now },
      ).reason,
    ).toBe("TOO_CLOSE");
  });
});

describe("rfi-ui approve body", () => {
  it("is built from exactly the displayed data", () => {
    const v = view();
    const body = buildApproveBody(v);
    expect(body).toMatchObject({
      draft_id: "dr",
      prompt_version: "pv",
      rfi_updated_at: v.rfi.airwallex_updated_at,
    });
    expect(body?.answers.map((a) => a.text)).toEqual(v.questions.map((q) => q.answer?.text));
    expect(body?.answers[0]?.fact_version_ids).toEqual(["v#0", "v#1"]);
    expect(body?.answers[0]?.question_id).toBe("aw-1");
  });
});

describe("rfi-ui misc", () => {
  it("maps reason codes to plain-language keys", () => {
    expect(needsOwnerKey("MODEL_UNAVAILABLE")).toBe("modelUnavailable");
    expect(needsOwnerKey("CANNOT_ANSWER")).toBe("noDocument");
    expect(needsOwnerKey("UNSUPPORTED_AMOUNT")).toBe("verifierRejected");
  });
  it("polls while open, not when answered", () => {
    expect(shouldPoll(view())).toBe(false);
    const v = view();
    expect(shouldPoll({ ...v, rfi: { ...v.rfi, state: "DRAFTING" } })).toBe(true);
  });
});
