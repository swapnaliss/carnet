// M3-05: follow-up drafting. A question with an approved answer for the same counterparty is decided from
// memory and never sent to the model; only unmatched questions are drafted (M2-05, unchanged). The
// Postgres side (rows, audit, approvals) is proven in apps/web/test/follow-up.int.test.ts.
import type { MemoryEntry, SuppliedFact } from "@carnet/domain";
import { describe, expect, it } from "vitest";
import { loadDraftingCases, loadDraftRecording } from "../../evals/drafting/run";
import { replayTransport } from "../../evals/extraction/run";
import "../../test/replay-env";
import { memoryStore } from "../../test/memory-store";
import type { DraftQuestion } from "../drafting/draft";
import type { DraftingStore } from "../drafting/handler";
import { runDrafting } from "../drafting/handler";
import { createHarness } from "../harness";
import type { Transport } from "../index";
import { combineFollowUp, planFollowUp, REUSE_PROMPT_VERSION, reuseOnlyResult } from "./follow-up";

const CASE = "rfi-set-lakeside-r1";

async function scenario() {
  const c = (await loadDraftingCases()).find((x) => x.id === CASE);
  if (!c) throw new Error("no case");
  const textQuestion = c.questions.find((q) => q.answerType === "TEXT");
  const fact = c.facts.find((f) => f.value !== "");
  if (!textQuestion || !fact) throw new Error("case has no TEXT question or fact");
  return { c, textQuestion, fact };
}

const entryFor = (fact: SuppliedFact, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: "mem-1",
  answerText: fact.value,
  citations: [
    { fact_version_id: fact.id, quote: fact.quote, document_id: fact.documentId, key: fact.key },
  ],
  attachments: [],
  approvedAt: new Date("2026-11-03T10:00:00.000Z"),
  sourceApprovalId: "appr-round-1",
  ...over,
});

function counting(inner: Transport): { transport: Transport; calls: () => number } {
  let calls = 0;
  return {
    transport: async (...args) => {
      calls += 1;
      return inner(...args);
    },
    calls: () => calls,
  };
}

function storeFor(
  questions: readonly DraftQuestion[],
  c: Awaited<ReturnType<typeof scenario>>["c"],
  matches: ReadonlyMap<string, MemoryEntry>,
) {
  const saved: Parameters<DraftingStore["saveDraft"]>[0][] = [];
  const store: DraftingStore = {
    async loadInput() {
      return {
        input: { questions, facts: c.facts, documents: c.documents },
        awaitingDraft: true,
        reuse: {
          matches,
          context: { facts: c.facts, documents: c.documents, documentHashes: new Map() },
        },
      };
    },
    async saveDraft(input) {
      saved.push(input);
      const ready = input.result.results.every((r) => r.verdict.status !== "NEEDS_OWNER");
      return {
        draftId: "d1",
        state: ready ? "DRAFT_READY" : "NEEDS_OWNER",
        inserted: true,
      };
    },
  };
  return { store, saved };
}

describe("follow-up drafting: zero model calls for approved answers", () => {
  it("zero model calls when every question of round 2 has an approved answer; the draft is marked reused", async () => {
    const { c, textQuestion, fact } = await scenario();
    const spy = counting(replayTransport(loadDraftRecording(CASE)));
    const harness = createHarness({
      store: memoryStore({ agentsEnabled: true }),
      transport: spy.transport,
    });
    const { store, saved } = storeFor(
      [textQuestion],
      c,
      new Map([[textQuestion.id, entryFor(fact)]]),
    );
    const out = await runDrafting({ harness, store, rfiId: "rfi", round: 2, draftKey: "job" });
    // Evidence for the ticket's gate (it greps this log): the transport saw no request.
    console.info(`round 2 follow-up: ${spy.calls()} model calls (zero model calls expected)`);
    expect(spy.calls()).toBe(0);
    expect(out).toMatchObject({ outcome: "drafted", state: "DRAFT_READY", kind: "reuse" });
    expect(saved[0]).toMatchObject({ round: 2, runId: null, origin: "system" });
    expect(saved[0]?.result.promptVersion).toBe(REUSE_PROMPT_VERSION);
    expect(saved[0]?.result.reuseProvenance?.[textQuestion.id]).toMatchObject({
      reused: true,
      source_approval_id: "appr-round-1",
    });
    expect(saved[0]?.result.results[0]).toMatchObject({
      question_id: textQuestion.id,
      answer: { text: fact.value },
    });
  });

  it("zero model calls when the approved answer no longer holds: NEEDS_OWNER (REUSE_STALE), provenance kept", async () => {
    const { c, textQuestion, fact } = await scenario();
    const spy = counting(replayTransport(loadDraftRecording(CASE)));
    const harness = createHarness({
      store: memoryStore({ agentsEnabled: true }),
      transport: spy.transport,
    });
    const gone = entryFor(fact, {
      citations: [
        {
          fact_version_id: "fv-gone#0",
          quote: "a quote no current fact has",
          document_id: fact.documentId,
          key: fact.key,
        },
      ],
    });
    const { store, saved } = storeFor([textQuestion], c, new Map([[textQuestion.id, gone]]));
    const out = await runDrafting({ harness, store, rfiId: "rfi", round: 2, draftKey: "job" });
    expect(spy.calls()).toBe(0);
    expect(out).toMatchObject({ state: "NEEDS_OWNER", kind: "reuse" });
    expect(saved[0]?.result.results[0]?.verdict).toMatchObject({
      status: "NEEDS_OWNER",
      reason: "REUSE_STALE",
    });
    expect(saved[0]?.result.reuseProvenance?.[textQuestion.id]?.source_approval_id).toBe(
      "appr-round-1",
    );
  });

  it("only the unmatched questions go to the model (one call), and the matched one is not sent", async () => {
    const { c, textQuestion, fact } = await scenario();
    const others = c.questions.filter((q) => q.id !== textQuestion.id);
    expect(others.length).toBeGreaterThan(0);
    const questions = [textQuestion, ...others];
    const matches = new Map([[textQuestion.id, entryFor(fact)]]);
    const plan = planFollowUp(questions, {
      matches,
      context: { facts: c.facts, documents: c.documents, documentHashes: new Map() },
    });
    expect(plan.toModel.map((q) => q.id)).toEqual(others.map((q) => q.id));
    expect(plan.local.map((r) => r.question_id)).toEqual([textQuestion.id]);

    const spy = counting(replayTransport(loadDraftRecording(CASE)));
    const harness = createHarness({
      store: memoryStore({ agentsEnabled: true }),
      transport: spy.transport,
    });
    const { store, saved } = storeFor(questions, c, matches);
    const out = await runDrafting({ harness, store, rfiId: "rfi", round: 2, draftKey: "job" });
    expect(spy.calls()).toBe(1);
    expect(out.kind).toBe("model");
    // The saved draft keeps the questions' order, with the reused one first and marked.
    expect(saved[0]?.result.results.map((r) => r.question_id)).toEqual(questions.map((q) => q.id));
    expect(Object.keys(saved[0]?.result.reuseProvenance ?? {})).toEqual([textQuestion.id]);
    expect(saved[0]?.runId).toBeTruthy();
  });

  it("an empty match set leaves round 2 to the model exactly as round 1 (the changed-text case)", async () => {
    const { c, textQuestion } = await scenario();
    const plan = planFollowUp([textQuestion], {
      matches: new Map(),
      context: { facts: c.facts, documents: c.documents, documentHashes: new Map() },
    });
    expect(plan.toModel).toEqual([textQuestion]);
    expect(plan.local).toEqual([]);
    expect(reuseOnlyResult(plan).results).toEqual([]);
    const modelResult = reuseOnlyResult(plan);
    expect(combineFollowUp([textQuestion], plan, modelResult).results).toEqual([]);
  });
});
