// The harness's storage port. packages/agent may import only @carnet/domain (ADR 0001), so the
// harness talks to storage through this interface; `agentHarnessStore(ctx)` in @carnet/db implements
// it over agent_runs, agent_steps and system_flags for one business. Tests use an in-memory store.

/** Network outcomes: the ones that write a step. */
export type StepOutcome =
  | "ok"
  | "refused"
  | "truncated"
  | "provider_error"
  // Refusals before the network (M4-02): written as zero-cost steps so the audit trail shows them.
  | "killed"
  | "spend_cap";

export interface AgentFlags {
  /** The kill switch (`system_flags.agents_enabled`). */
  readonly agentsEnabled: boolean;
  /** `system_flags.per_run_cap_minor`, converted to nano-USD. */
  readonly perRunCapNanoUsd: number;
  /** `system_flags.daily_spend_cap_minor`, converted to nano-USD. */
  readonly dailyCapNanoUsd: number;
}

export interface RunRecord {
  readonly id: string;
  readonly kind: string;
  readonly ref: string;
  readonly startedAt: Date;
  readonly costNanoUsd: number;
}

export interface StepKey {
  readonly kind: string;
  readonly ref: string;
  readonly step: string;
}

export interface ReplayKey extends StepKey {
  readonly inputHash: string;
  readonly promptVersion: string;
}

export interface StoredStep {
  readonly id: string;
  readonly output: unknown;
}

export interface NewStepRecord {
  readonly runId: string;
  readonly step: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly inputHash: string;
  readonly outcome: StepOutcome;
  readonly output: unknown;
  readonly stopReason: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanoUsd: number;
  readonly latencyMs: number;
  readonly providerRequestId: string | null;
}

export interface HarnessStore {
  /** Read fresh before every call. Throwing means "treat as disabled". */
  readFlags(): Promise<AgentFlags>;
  createRun(input: { kind: string; ref: string }): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | null>;
  finishRun(id: string, status: "DONE" | "FAILED"): Promise<void>;
  findReplayableStep(key: ReplayKey): Promise<StoredStep | null>;
  /** Network calls already recorded for this question (all runs of the same kind and ref). */
  countCalls(key: StepKey): Promise<number>;
  /** Spend of every step since `since`, across all businesses (the daily cap is platform-wide). */
  spentSinceNanoUsd(since: Date): Promise<number>;
  /** Writes the step and adds its tokens and cost to the run, atomically. Returns the step id. */
  recordStep(step: NewStepRecord): Promise<string>;
}
