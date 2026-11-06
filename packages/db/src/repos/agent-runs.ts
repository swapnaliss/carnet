// Model runs and steps (M2-00). Tenant repository: every function takes `ctx` first and scopes by
// `ctx.businessId`. The daily spend total across businesses is a system query (system.ts,
// `agentSpendSince`). The harness in @carnet/agent reaches these through `agentHarnessStore`
// (agent-store.ts).
import type { BusinessId } from "@carnet/domain";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { translateDbError } from "../errors";
import { type AgentRunStatus, type AgentStepOutcome, agentRuns, agentSteps } from "../schema/index";
import type { RepoCtx } from "./context";

export interface AgentRun {
  readonly id: string;
  readonly businessId: BusinessId;
  readonly kind: string;
  readonly ref: string;
  readonly status: AgentRunStatus;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanoUsd: number;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

export interface AgentStep {
  readonly id: string;
  readonly businessId: BusinessId;
  readonly runId: string;
  readonly step: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly inputHash: string;
  readonly outcome: AgentStepOutcome;
  readonly output: unknown;
  readonly stopReason: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanoUsd: number;
  readonly latencyMs: number;
  readonly providerRequestId: string | null;
  readonly createdAt: Date;
}

const toRun = (r: typeof agentRuns.$inferSelect): AgentRun => ({
  ...r,
  businessId: r.businessId as BusinessId,
});
const toStep = (r: typeof agentSteps.$inferSelect): AgentStep => ({
  ...r,
  businessId: r.businessId as BusinessId,
  output: r.output ?? null,
});

export interface NewAgentRun {
  id?: string;
  kind: string;
  ref: string;
}

export async function createAgentRun(ctx: RepoCtx, input: NewAgentRun): Promise<AgentRun> {
  try {
    const [row] = await ctx.db
      .insert(agentRuns)
      .values({
        ...(input.id ? { id: input.id } : {}),
        businessId: ctx.businessId,
        kind: input.kind,
        ref: input.ref,
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return toRun(row);
  } catch (error) {
    throw translateDbError(error);
  }
}

export async function getAgentRun(ctx: RepoCtx, id: string): Promise<AgentRun | null> {
  const [row] = await ctx.db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.businessId, ctx.businessId), eq(agentRuns.id, id)));
  return row ? toRun(row) : null;
}

export async function finishAgentRun(
  ctx: RepoCtx,
  id: string,
  status: Exclude<AgentRunStatus, "RUNNING">,
): Promise<AgentRun | null> {
  const [row] = await ctx.db
    .update(agentRuns)
    .set({ status, finishedAt: new Date() })
    .where(and(eq(agentRuns.businessId, ctx.businessId), eq(agentRuns.id, id)))
    .returning();
  return row ? toRun(row) : null;
}

export interface NewAgentStep {
  runId: string;
  step: string;
  promptVersion: string;
  model: string;
  inputHash: string;
  outcome: AgentStepOutcome;
  output: unknown;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  costNanoUsd: number;
  latencyMs: number;
  providerRequestId: string | null;
}

/**
 * Records one model call and adds its tokens and cost to the run, in one transaction. Returns null
 * (and writes nothing) when the run is not this business's.
 */
export async function recordAgentStep(
  ctx: RepoCtx,
  input: NewAgentStep,
): Promise<AgentStep | null> {
  try {
    return await ctx.db.transaction(async (tx) => {
      const [run] = await tx
        .update(agentRuns)
        .set({
          inputTokens: sql`${agentRuns.inputTokens} + ${input.inputTokens}`,
          outputTokens: sql`${agentRuns.outputTokens} + ${input.outputTokens}`,
          costNanoUsd: sql`${agentRuns.costNanoUsd} + ${input.costNanoUsd}`,
        })
        .where(and(eq(agentRuns.businessId, ctx.businessId), eq(agentRuns.id, input.runId)))
        .returning({ id: agentRuns.id });
      if (!run) return null;
      const [row] = await tx
        .insert(agentSteps)
        .values({ ...input, businessId: ctx.businessId, output: input.output ?? null })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return toStep(row);
    });
  } catch (error) {
    throw translateDbError(error);
  }
}

export async function listAgentSteps(ctx: RepoCtx, runId: string): Promise<AgentStep[]> {
  const rows = await ctx.db
    .select()
    .from(agentSteps)
    .where(and(eq(agentSteps.businessId, ctx.businessId), eq(agentSteps.runId, runId)))
    .orderBy(asc(agentSteps.createdAt));
  return rows.map(toStep);
}

export interface AgentStepKey {
  kind: string;
  ref: string;
  step: string;
}

export interface AgentReplayKey extends AgentStepKey {
  inputHash: string;
  promptVersion: string;
}

/**
 * The newest successful step with the same (run kind, ref, step, input hash, prompt version), in this
 * business: the stored output a crashed or repeated run replays instead of calling the model again.
 */
export async function findReplayableAgentStep(
  ctx: RepoCtx,
  key: AgentReplayKey,
): Promise<AgentStep | null> {
  const [row] = await ctx.db
    .select({ step: agentSteps })
    .from(agentSteps)
    .innerJoin(
      agentRuns,
      and(eq(agentRuns.id, agentSteps.runId), eq(agentRuns.businessId, agentSteps.businessId)),
    )
    .where(
      and(
        eq(agentSteps.businessId, ctx.businessId),
        eq(agentRuns.kind, key.kind),
        eq(agentRuns.ref, key.ref),
        eq(agentSteps.step, key.step),
        eq(agentSteps.inputHash, key.inputHash),
        eq(agentSteps.promptVersion, key.promptVersion),
        eq(agentSteps.outcome, "ok"),
      ),
    )
    .orderBy(sql`${agentSteps.createdAt} DESC`)
    .limit(1);
  return row ? toStep(row.step) : null;
}

/** Model calls already made for one question (run kind + ref + step), across runs. */
export async function countAgentCalls(ctx: RepoCtx, key: AgentStepKey): Promise<number> {
  const [row] = await ctx.db
    .select({ n: count() })
    .from(agentSteps)
    .innerJoin(
      agentRuns,
      and(eq(agentRuns.id, agentSteps.runId), eq(agentRuns.businessId, agentSteps.businessId)),
    )
    .where(
      and(
        eq(agentSteps.businessId, ctx.businessId),
        eq(agentRuns.kind, key.kind),
        eq(agentRuns.ref, key.ref),
        eq(agentSteps.step, key.step),
      ),
    );
  return row?.n ?? 0;
}
