// M4-02 AC 5 (agent side): the per-run cap stops a multi-call run at the cap with a `spend_cap` step,
// the daily cap blocks the next run, and a rolled-over UTC day allows it again. Actual cost is what
// counts toward the figures. (Against the database: packages/db/test/inflight-semantics.test.ts.)
import { describe, expect, it } from "vitest";
import { createHarness, utcDayStart } from "../src/index";
import { memoryStore, patchFlags, USD } from "./memory-store";
import { DRAFT_SYSTEM, DRAFT_VERSION, Draft, draftBlocks } from "./prompts";
import { recordedResponse, recordingTransport } from "./recorded";

process.env.ANTHROPIC_API_KEY ||= "test-not-a-key";

const callOf = (run: { id: string; kind: string; ref: string }, step: string) => ({
  run,
  step,
  promptVersion: DRAFT_VERSION,
  model: "claude-sonnet-5-5" as const,
  system: DRAFT_SYSTEM,
  blocks: draftBlocks("Please describe the purpose of this payment."),
  schema: Draft,
  maxTokens: 1500,
});

describe("per-run cap", () => {
  it("stops a multi-call run at the cap; the step and the spend figures agree", async () => {
    let clock = new Date("2026-11-13T10:00:00Z");
    const store = memoryStore({ perRunCapNanoUsd: 0.025 * USD }, () => clock);
    const rec = recordingTransport([
      recordedResponse("draft-harbor-purpose"),
      recordedResponse("draft-harbor-purpose"),
    ]);
    const harness = createHarness({
      store,
      transport: rec.transport,
      maxRetries: 0,
      now: () => clock,
    });
    const run = await harness.startRun({ kind: "draft", ref: "rfi-1" });
    expect((await harness.callStructured(callOf(run, "q1"))).outcome).toBe("ok");
    clock = new Date(clock.getTime() + 1000);
    const second = await harness.callStructured(callOf(run, "q2"));
    expect(second).toMatchObject({ outcome: "cap_exceeded", cap: "per_run" });
    expect(rec.requests).toHaveLength(1);
    expect(store.steps.map((s) => s.outcome)).toEqual(["ok", "spend_cap"]);
    // Spend equals the run's recorded cost: the refused step added nothing.
    expect(store.runs.get(run.id)?.costNanoUsd).toBe(10_584_000);
    expect(await store.spentSinceNanoUsd(utcDayStart(clock))).toBe(10_584_000);
  });
});

describe("daily cap and the UTC day", () => {
  it("blocks the next run when the day's spend leaves no room, and allows it after midnight UTC", async () => {
    let clock = new Date("2026-11-13T23:59:00Z");
    const store = memoryStore({ dailyCapNanoUsd: 10 * USD }, () => clock);
    const rec = recordingTransport([recordedResponse("draft-harbor-purpose")]);
    const harness = createHarness({
      store,
      transport: rec.transport,
      maxRetries: 0,
      now: () => clock,
    });
    // Another business spent all but a cent today.
    store.otherSpendToday = 10 * USD - 0.01 * USD;
    const run = await harness.startRun({ kind: "draft", ref: "rfi-1" });
    expect(await harness.callStructured(callOf(run, "q1"))).toMatchObject({
      outcome: "cap_exceeded",
      cap: "daily",
    });
    expect(rec.requests).toHaveLength(0);

    // The day rolls over: yesterday's spend no longer counts.
    clock = new Date("2026-11-14T00:00:01Z");
    store.otherSpendToday = 0;
    patchFlags(store, {});
    const next = await harness.startRun({ kind: "draft", ref: "rfi-2" });
    expect((await harness.callStructured(callOf(next, "q1"))).outcome).toBe("ok");
    expect(rec.requests).toHaveLength(1);
  });
});
