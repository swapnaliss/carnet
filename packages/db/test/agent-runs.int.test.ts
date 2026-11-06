// M2-00: agent_runs / agent_steps against Postgres, through the repository and through
// `agentHarnessStore`, the database implementation of @carnet/agent's HarnessStore port.
// Cross-tenant cases for every function are in tenancy.int.test.ts.
import { money } from "@carnet/domain";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import * as repos from "../src/repos/index";
import { createBusiness } from "../src/repos/system";
import { useTestDatabase, withClient } from "./harness";

const db = useTestDatabase();

const step = (runId: string, over: Partial<repos.NewAgentStep> = {}): repos.NewAgentStep => ({
  runId,
  step: "q-purpose",
  promptVersion: "65dd991ed6a2",
  model: "claude-sonnet-5-5",
  inputHash: "a".repeat(64),
  outcome: "ok",
  output: { status: "ANSWER", answer: "stored" },
  stopReason: "end_turn",
  inputTokens: 1732,
  outputTokens: 712,
  costNanoUsd: 10_584_000,
  latencyMs: 4481,
  providerRequestId: "req_011CghRdgdX9AfBZzdj7cxCV",
  ...over,
});

let ctx: repos.RepoCtx;
let other: repos.RepoCtx;

beforeAll(async () => {
  const { app } = db();
  ctx = repos.repoCtx(app.db, await createBusiness(app.db, { name: "agent-co" }));
  other = repos.repoCtx(app.db, await createBusiness(app.db, { name: "other-co" }));
});

describe("agent_runs / agent_steps", () => {
  it("records a step and adds its tokens and cost to the run in one transaction", async () => {
    const run = await repos.createAgentRun(ctx, { kind: "draft", ref: "rfi-1" });
    expect(run).toMatchObject({ status: "RUNNING", costNanoUsd: 0, inputTokens: 0 });
    const s = await repos.recordAgentStep(ctx, step(run.id));
    expect(s).toMatchObject({ outcome: "ok", stopReason: "end_turn", costNanoUsd: 10_584_000 });
    await repos.recordAgentStep(
      ctx,
      step(run.id, { outcome: "truncated", output: null, inputTokens: 2606, outputTokens: 60 }),
    );
    const after = await repos.getAgentRun(ctx, run.id);
    expect(after).toMatchObject({ inputTokens: 1732 + 2606, outputTokens: 712 + 60 });
    expect(after?.costNanoUsd).toBe(2 * 10_584_000);
    expect(await repos.listAgentSteps(ctx, run.id)).toHaveLength(2);
    const done = await repos.finishAgentRun(ctx, run.id, "DONE");
    expect(done?.status).toBe("DONE");
    expect(done?.finishedAt).toBeInstanceOf(Date);
  });

  it("a step cannot point at another business's run (composite key)", async () => {
    const run = await repos.createAgentRun(other, { kind: "draft", ref: "rfi-x" });
    await expect(
      withClient(db().appUrl, (c) =>
        c.query(
          `INSERT INTO agent_steps (business_id, run_id, step, prompt_version, model, input_hash, outcome, latency_ms)
           VALUES ($1, $2, 's', 'v', 'm', 'h', 'ok', 1)`,
          [ctx.businessId, run.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects an unknown outcome and a negative cost (check constraints)", async () => {
    const run = await repos.createAgentRun(ctx, { kind: "draft", ref: "rfi-chk" });
    await expect(
      repos.recordAgentStep(ctx, step(run.id, { outcome: "maybe" as never })),
    ).rejects.toThrow();
    await expect(repos.recordAgentStep(ctx, step(run.id, { costNanoUsd: -1 }))).rejects.toThrow();
  });

  it("has the (run_id, step) and (kind, ref) indexes", async () => {
    const rows = await db().app.db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename IN ('agent_runs', 'agent_steps')`,
    );
    const names = rows.rows.map((r) => (r as { indexname: string }).indexname);
    expect(names).toEqual(
      expect.arrayContaining(["agent_runs_kind_ref_idx", "agent_steps_run_id_step_idx"]),
    );
  });
});

describe("agentHarnessStore (the HarnessStore port over Postgres)", () => {
  it("reads the kill switch and converts the seeded caps to nano-USD", async () => {
    const store = repos.agentHarnessStore(ctx);
    // Seeded by migration 0001: USD 100 minor per run ($1), USD 1000 minor per day ($10).
    expect(await store.readFlags()).toEqual({
      agentsEnabled: true,
      perRunCapNanoUsd: 1_000_000_000,
      dailyCapNanoUsd: 10_000_000_000,
    });
    expect(repos.capToNanoUsd(money(1n, "USD"))).toBe(10_000_000);
    expect(repos.capToNanoUsd(money(100n, "EUR"))).toBe(0);
  });

  it("crash replay: a stored step is found again by a new run with identical inputs", async () => {
    const store = repos.agentHarnessStore(ctx);
    const run1 = await store.createRun({ kind: "draft", ref: "rfi-crash" });
    await store.recordStep(step(run1.id, { step: "q1" }));
    // The process dies here. A new process starts a new run for the same RFI.
    const run2 = await store.createRun({ kind: "draft", ref: "rfi-crash" });
    const key = {
      kind: "draft",
      ref: "rfi-crash",
      step: "q1",
      inputHash: "a".repeat(64),
      promptVersion: "65dd991ed6a2",
    };
    const hit = await store.findReplayableStep(key);
    expect(hit?.output).toEqual({ status: "ANSWER", answer: "stored" });
    expect((await store.getRun(run2.id))?.costNanoUsd).toBe(0);
    // A different prompt version, input hash or a failed step never replays.
    expect(await store.findReplayableStep({ ...key, promptVersion: "000000000000" })).toBeNull();
    expect(await store.findReplayableStep({ ...key, inputHash: "b".repeat(64) })).toBeNull();
    await store.recordStep(
      step(run2.id, { step: "q2", outcome: "refused", output: null, stopReason: "refusal" }),
    );
    expect(await store.findReplayableStep({ ...key, step: "q2" })).toBeNull();
  });

  it("counts calls per question across runs of the same kind and ref", async () => {
    const store = repos.agentHarnessStore(ctx);
    const a = await store.createRun({ kind: "draft", ref: "rfi-count" });
    const b = await store.createRun({ kind: "draft", ref: "rfi-count" });
    await store.recordStep(step(a.id, { step: "q1", outcome: "truncated", output: null }));
    await store.recordStep(step(b.id, { step: "q1" }));
    await store.recordStep(step(b.id, { step: "q2" }));
    expect(await store.countCalls({ kind: "draft", ref: "rfi-count", step: "q1" })).toBe(2);
    expect(await store.countCalls({ kind: "draft", ref: "rfi-count", step: "q2" })).toBe(1);
    expect(await store.countCalls({ kind: "extract", ref: "rfi-count", step: "q1" })).toBe(0);
  });

  it("the daily total sums every business since the window start", async () => {
    const mine = repos.agentHarnessStore(ctx);
    const theirs = repos.agentHarnessStore(other);
    const since = new Date(Date.now() - 1_000);
    const before = await mine.spentSinceNanoUsd(since);
    const r1 = await mine.createRun({ kind: "x", ref: "daily" });
    const r2 = await theirs.createRun({ kind: "x", ref: "daily" });
    await mine.recordStep(step(r1.id, { costNanoUsd: 1_000 }));
    await theirs.recordStep(step(r2.id, { costNanoUsd: 2_000 }));
    expect((await mine.spentSinceNanoUsd(since)) - before).toBe(3_000);
    expect(await mine.spentSinceNanoUsd(new Date(Date.now() + 60_000))).toBe(0);
  });

  it("recordStep on another business's run throws and writes nothing", async () => {
    const theirs = await repos.createAgentRun(other, { kind: "draft", ref: "rfi-o" });
    await expect(repos.agentHarnessStore(ctx).recordStep(step(theirs.id))).rejects.toThrow();
    expect(await repos.listAgentSteps(other, theirs.id)).toEqual([]);
  });
});
