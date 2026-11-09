// `runDrafting` / `runDraftTimeout` over an in-memory DraftingStore: the job body is idempotent and never
// leaves an RFI waiting (the Postgres side is proven in apps/web/test/rfi-drafting.int.test.ts).
import { describe, expect, it } from "vitest";
import { loadDraftingCases, loadDraftRecording } from "../../evals/drafting/run";
import { replayTransport } from "../../evals/extraction/run";
import { createHarness, type DraftingStore, runDraftTimeout, runDrafting } from "../../src/index";
import { memoryStore } from "../memory-store";

process.env.ANTHROPIC_API_KEY ||= "test-not-a-key";

async function setup(awaiting = true) {
  const c = (await loadDraftingCases()).find((x) => x.id === "rfi-set-lakeside-r1");
  if (!c) throw new Error("no case");
  const saved: Parameters<DraftingStore["saveDraft"]>[0][] = [];
  let waiting = awaiting;
  const store: DraftingStore = {
    async loadInput() {
      return {
        input: { questions: c.questions, facts: c.facts, documents: c.documents },
        awaitingDraft: waiting,
      };
    },
    async saveDraft(input) {
      saved.push(input);
      waiting = false;
      const state = input.result.results.every((r) => r.verdict.status !== "NEEDS_OWNER")
        ? "DRAFT_READY"
        : "NEEDS_OWNER";
      return { draftId: `d${saved.length}`, state, inserted: true };
    },
  };
  const harness = createHarness({
    store: memoryStore({ agentsEnabled: true }),
    transport: replayTransport(loadDraftRecording("rfi-set-lakeside-r1")),
  });
  return { harness, store, saved };
}

describe("runDrafting", () => {
  it("drafts once, saves the draft with its run and key, and reports the state", async () => {
    const { harness, store, saved } = await setup();
    const out = await runDrafting({
      harness,
      store,
      rfiId: "rfi-1",
      round: 1,
      draftKey: "job-1",
      model: "claude-sonnet-5-5",
    });
    expect(out).toMatchObject({ outcome: "drafted", state: "NEEDS_OWNER", kind: "model" });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      rfiId: "rfi-1",
      round: 1,
      draftKey: "job-1",
      origin: "model",
    });
    expect(saved[0]?.runId).toBeTruthy();
  });

  it("skips an RFI that no longer awaits a draft (a retried or duplicate job)", async () => {
    const { harness, store, saved } = await setup(false);
    const out = await runDrafting({ harness, store, rfiId: "rfi-1", round: 1, draftKey: "job-2" });
    expect(out.outcome).toBe("skipped");
    expect(saved).toHaveLength(0);
  });

  it("the timeout path writes a system draft in which every question is NEEDS_OWNER (MODEL_UNAVAILABLE)", async () => {
    const { store, saved } = await setup();
    const out = await runDraftTimeout({ store, rfiId: "rfi-1", round: 1 });
    expect(out).toMatchObject({ outcome: "drafted", kind: "unavailable", state: "NEEDS_OWNER" });
    expect(saved[0]).toMatchObject({ origin: "system", runId: null, draftKey: "timeout:r1" });
    expect(saved[0]?.result.results.every((r) => r.verdict.reason === "MODEL_UNAVAILABLE")).toBe(
      true,
    );
    expect(saved[0]?.result.results.every((r) => r.verdict.detail === "draft_timeout")).toBe(true);
    // Once saved, the RFI no longer waits: a second sweep is a no-op.
    expect((await runDraftTimeout({ store, rfiId: "rfi-1", round: 1 })).outcome).toBe("skipped");
  });
});
