// The database implementation of @carnet/agent's `HarnessStore` port for one business (M2-00). It is
// structurally typed (packages/db may not import @carnet/agent, ADR 0001): the caller that wires the
// harness (apps/web, M2-02) passes `agentHarnessStore(repoCtx(db, businessId))` as `store`.
// Each method is a tenant repository function from agent-runs.ts (covered by the cross-tenant tests),
// except the flags and the daily total, which are platform-wide (system.ts).
import type { Money } from "@carnet/domain";
import {
  countAgentCalls,
  createAgentRun,
  findReplayableAgentStep,
  finishAgentRun,
  getAgentRun,
  type NewAgentStep,
  recordAgentStep,
} from "./agent-runs";
import type { RepoCtx } from "./context";
import { sessionModelSpendNanoUsd } from "./replay";
import { agentSpendSince, getSystemFlags } from "./system";

/** USD minor units (cents) to nano-USD. A cap in any other currency allows nothing. */
export function capToNanoUsd(cap: Money): number {
  return cap.currency === "USD" ? Number(cap.minor) * 10_000_000 : 0;
}

interface StoreRun {
  id: string;
  kind: string;
  ref: string;
  startedAt: Date;
  costNanoUsd: number;
}

const runView = (r: StoreRun): StoreRun => ({
  id: r.id,
  kind: r.kind,
  ref: r.ref,
  startedAt: r.startedAt,
  costNanoUsd: r.costNanoUsd,
});

/**
 * M4-05: a run queued by a web session is attributed to it, and the session's cap
 * (SESSION_MODEL_CAP_USD, nano-USD) is checked fresh before every call with the per-run and daily caps.
 */
export interface SessionAttribution {
  readonly sessionId: string;
  readonly capNanoUsd: number;
}

export function agentHarnessStore(ctx: RepoCtx, session?: SessionAttribution | null) {
  return {
    async readFlags() {
      const flags = await getSystemFlags(ctx.db);
      return {
        agentsEnabled: flags.agentsEnabled,
        perRunCapNanoUsd: capToNanoUsd(flags.perRunCap),
        dailyCapNanoUsd: capToNanoUsd(flags.dailySpendCap),
        ...(session
          ? {
              session: {
                capNanoUsd: session.capNanoUsd,
                spentNanoUsd: await sessionModelSpendNanoUsd(ctx.db, session.sessionId),
              },
            }
          : {}),
      };
    },
    async createRun(input: { kind: string; ref: string }) {
      return runView(
        await createAgentRun(ctx, { ...input, sessionId: session?.sessionId ?? null }),
      );
    },
    async getRun(id: string) {
      const run = await getAgentRun(ctx, id);
      return run ? runView(run) : null;
    },
    async finishRun(id: string, status: "DONE" | "FAILED") {
      await finishAgentRun(ctx, id, status);
    },
    async findReplayableStep(key: {
      kind: string;
      ref: string;
      step: string;
      inputHash: string;
      promptVersion: string;
    }) {
      const step = await findReplayableAgentStep(ctx, key);
      return step ? { id: step.id, output: step.output } : null;
    },
    async countCalls(key: { kind: string; ref: string; step: string }) {
      return countAgentCalls(ctx, key);
    },
    async spentSinceNanoUsd(since: Date) {
      return agentSpendSince(ctx.db, since);
    },
    async recordStep(step: NewAgentStep) {
      const row = await recordAgentStep(ctx, step);
      if (!row) throw new Error(`agent run ${step.runId} not found for this business`);
      return row.id;
    },
  };
}
