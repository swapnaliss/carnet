// M4-02 AC 1: with agents_enabled=false no model request is made by a draft or an extraction run, the
// refusal is recorded as a zero-cost `killed` step, and the flag is read fresh on every call.
import { describe, expect, it } from "vitest";
import { loadDraftingCases } from "../evals/drafting/run";
import { createHarness, draftRfi } from "../src/index";
import { memoryStore, patchFlags } from "./memory-store";
import {
  DRAFT_SYSTEM,
  DRAFT_VERSION,
  Draft,
  draftBlocks,
  EXTRACT_SYSTEM,
  EXTRACT_VERSION,
  Extraction,
} from "./prompts";
import { recordedResponse, recordingTransport } from "./recorded";

process.env.ANTHROPIC_API_KEY ||= "test-not-a-key";

function rig() {
  const store = memoryStore({ agentsEnabled: false });
  const rec = recordingTransport([recordedResponse("draft-harbor-purpose")]);
  const harness = createHarness({ store, transport: rec.transport, maxRetries: 0 });
  return { store, rec, harness };
}

describe("agents_enabled = false", () => {
  it("a draft run makes zero model requests and records killed steps", async () => {
    const { store, rec, harness } = rig();
    const c = (await loadDraftingCases()).find((x) => x.id === "rfi-set-harbor-r1");
    if (!c) throw new Error("no case");
    const run = await harness.startRun({ kind: "rfi_draft", ref: "r" });
    const res = await draftRfi({
      harness,
      run,
      step: "s",
      input: { questions: c.questions, facts: c.facts, documents: c.documents },
    });
    expect(res.unavailable?.code).toBe("AGENTS_DISABLED");
    expect(rec.requests).toHaveLength(0);
    expect(store.steps.length).toBeGreaterThan(0);
    expect(store.steps.every((s) => s.outcome === "killed" && s.costNanoUsd === 0)).toBe(true);
    expect(store.runs.get(run.id)?.costNanoUsd).toBe(0);
  });

  it("an extraction run makes zero model requests and records a killed step", async () => {
    const { store, rec, harness } = rig();
    const run = await harness.startRun({ kind: "extract", ref: "doc-1" });
    const out = await harness.callStructured({
      run,
      step: "extract",
      promptVersion: EXTRACT_VERSION,
      model: "claude-haiku-5-5",
      system: EXTRACT_SYSTEM,
      blocks: [{ type: "text", text: "document" }],
      schema: Extraction,
      maxTokens: 2000,
    });
    expect(out).toEqual({ outcome: "disabled", replayed: false, code: "AGENTS_DISABLED" });
    expect(rec.requests).toHaveLength(0);
    expect(store.steps.map((s) => s.outcome)).toEqual(["killed"]);
  });

  it("killed steps are not calls: re-enabling lets the question through its full allowance", async () => {
    const { store, rec, harness } = rig();
    const run = await harness.startRun({ kind: "draft", ref: "rfi-1" });
    const call = {
      run,
      step: "q",
      promptVersion: DRAFT_VERSION,
      model: "claude-sonnet-5-5" as const,
      system: DRAFT_SYSTEM,
      blocks: draftBlocks("Please describe the purpose of this payment."),
      schema: Draft,
      maxTokens: 1500,
    };
    for (let i = 0; i < 5; i += 1)
      expect((await harness.callStructured(call)).outcome).toBe("disabled");
    patchFlags(store, { agentsEnabled: true });
    expect((await harness.callStructured(call)).outcome).toBe("ok");
    expect(rec.requests).toHaveLength(1);
  });
});
