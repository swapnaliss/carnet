// Test double for the HarnessStore port: the same semantics as `agentHarnessStore` in @carnet/db
// (which packages/db/test/agent-runs.int.test.ts proves against Postgres), held in memory.
import { randomUUID } from "node:crypto";
import type {
  AgentFlags,
  HarnessStore,
  NewStepRecord,
  ReplayKey,
  RunRecord,
  StepKey,
} from "../src/index";

export interface MemoryRun extends RunRecord {
  status: "RUNNING" | "DONE" | "FAILED";
  inputTokens: number;
  outputTokens: number;
  costNanoUsd: number;
}

export interface MemoryStep extends NewStepRecord {
  id: string;
  createdAt: Date;
}

export interface MemoryStore extends HarnessStore {
  flags: AgentFlags | null;
  runs: Map<string, MemoryRun>;
  steps: MemoryStep[];
  /** Spend recorded outside this store today (other businesses), nano-USD. */
  otherSpendToday: number;
  flagReads: number;
}

export const USD = 1_000_000_000;

export function memoryStore(
  flags: Partial<AgentFlags> = {},
  now: () => Date = () => new Date(),
): MemoryStore {
  const store: MemoryStore = {
    flags: {
      agentsEnabled: true,
      perRunCapNanoUsd: 1 * USD,
      dailyCapNanoUsd: 10 * USD,
      ...flags,
    },
    runs: new Map(),
    steps: [],
    otherSpendToday: 0,
    flagReads: 0,
    async readFlags() {
      store.flagReads += 1;
      if (!store.flags) throw new Error("system_flags row missing");
      return store.flags;
    },
    async createRun(input) {
      const run: MemoryRun = {
        id: randomUUID(),
        kind: input.kind,
        ref: input.ref,
        startedAt: now(),
        status: "RUNNING",
        inputTokens: 0,
        outputTokens: 0,
        costNanoUsd: 0,
      };
      store.runs.set(run.id, run);
      return { ...run };
    },
    async getRun(id) {
      const run = store.runs.get(id);
      return run ? { ...run } : null;
    },
    async finishRun(id, status) {
      const run = store.runs.get(id);
      if (run) run.status = status;
    },
    async findReplayableStep(key: ReplayKey) {
      const hit = [...store.steps]
        .reverse()
        .find(
          (s) =>
            s.outcome === "ok" &&
            matches(store.runs.get(s.runId), s, key) &&
            s.inputHash === key.inputHash &&
            s.promptVersion === key.promptVersion,
        );
      return hit ? { id: hit.id, output: hit.output } : null;
    },
    async countCalls(key: StepKey) {
      return store.steps.filter(
        (s) =>
          s.outcome !== "killed" &&
          s.outcome !== "spend_cap" &&
          matches(store.runs.get(s.runId), s, key),
      ).length;
    },
    async spentSinceNanoUsd(since) {
      return (
        store.otherSpendToday +
        store.steps.filter((s) => s.createdAt >= since).reduce((a, s) => a + s.costNanoUsd, 0)
      );
    },
    async recordStep(step) {
      const run = store.runs.get(step.runId);
      if (!run) throw new Error("run not found");
      const id = randomUUID();
      store.steps.push({ ...step, id, createdAt: now() });
      run.inputTokens += step.inputTokens;
      run.outputTokens += step.outputTokens;
      run.costNanoUsd += step.costNanoUsd;
      return id;
    },
  };
  return store;
}

/** Changes the flags row as an operator would (a missing row is restored first). */
export function patchFlags(store: MemoryStore, patch: Partial<AgentFlags>): void {
  store.flags = {
    agentsEnabled: true,
    perRunCapNanoUsd: 1 * USD,
    dailyCapNanoUsd: 10 * USD,
    ...store.flags,
    ...patch,
  };
}

function matches(run: RunRecord | undefined, step: { step: string }, key: StepKey): boolean {
  return !!run && run.kind === key.kind && run.ref === key.ref && step.step === key.step;
}
