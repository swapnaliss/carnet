// Governance (M4-02): the kill switches, the spend figures and the audited toggle. The switches are
// the two booleans of system_flags; `getSystemFlags` (system.ts) is the one reader and every decision
// point calls it fresh, with no cache. A flag that cannot be read counts as off (fail closed).
import { desc, eq, gte, sql } from "drizzle-orm";
import { appendAudit } from "../audit/append";
import { withTransaction } from "../client";
import { SystemFlagsMissingError, translateDbError } from "../errors";
import { agentRuns, auditLog, systemFlags } from "../schema/index";
import type { RepoCtx } from "./context";
import { agentSpendSince, utcDayStartOf } from "./system";

export type SwitchName = "agents_enabled" | "execution_enabled";
export const SWITCH_NAMES: readonly SwitchName[] = ["agents_enabled", "execution_enabled"];
export const FLAG_AUDIT_ACTION = "system_flag.changed";

export interface SetSwitchInput {
  readonly flag: SwitchName;
  readonly value: boolean;
  readonly actorId: string;
  readonly reason?: string | undefined;
}

export interface SetSwitchResult {
  readonly flag: SwitchName;
  readonly changed: boolean;
  readonly before: boolean;
  readonly after: boolean;
}

/**
 * Sets a switch and writes the audit entry (actor, old and new value, reason) in the same
 * transaction. Setting a switch to the value it already has changes and audits nothing.
 */
export async function setSwitch(ctx: RepoCtx, input: SetSwitchInput): Promise<SetSwitchResult> {
  try {
    return await withTransaction(ctx.db, async (tx) => {
      const [row] = await tx.select().from(systemFlags).where(eq(systemFlags.id, 1)).for("update");
      if (!row) throw new SystemFlagsMissingError();
      const before = input.flag === "agents_enabled" ? row.agentsEnabled : row.executionEnabled;
      if (before === input.value) {
        return { flag: input.flag, changed: false, before, after: before };
      }
      await tx
        .update(systemFlags)
        .set({
          ...(input.flag === "agents_enabled"
            ? { agentsEnabled: input.value }
            : { executionEnabled: input.value }),
          updatedAt: sql`now()`,
        })
        .where(eq(systemFlags.id, 1));
      await auditSwitchChange({ db: tx, businessId: ctx.businessId }, input, before);
      return { flag: input.flag, changed: true, before, after: input.value };
    });
  } catch (error) {
    if (error instanceof SystemFlagsMissingError) throw error;
    throw translateDbError(error);
  }
}

// The only audit call site of this module; it runs inside the toggle transaction.
async function auditSwitchChange(
  rc: RepoCtx,
  input: SetSwitchInput,
  before: boolean,
): Promise<void> {
  await appendAudit(rc, {
    actorType: "user",
    actorId: input.actorId,
    action: FLAG_AUDIT_ACTION,
    subject: input.flag,
    data: { flag: input.flag, old: before, new: input.value, reason: input.reason ?? null },
  });
}

export interface SwitchChange {
  readonly flag: string;
  readonly actorId: string | null;
  readonly at: Date;
  readonly newValue: boolean | null;
  readonly reason: string | null;
}

/** The most recent change of each switch, from the audit log (tenant scoped). */
export async function lastSwitchChanges(
  ctx: RepoCtx,
): Promise<Partial<Record<SwitchName, SwitchChange>>> {
  const rows = await ctx.db
    .select()
    .from(auditLog)
    .where(
      sql`${auditLog.businessId} = ${ctx.businessId} and ${auditLog.action} = ${FLAG_AUDIT_ACTION}`,
    )
    .orderBy(desc(auditLog.id))
    .limit(50);
  const out: Partial<Record<SwitchName, SwitchChange>> = {};
  for (const r of rows) {
    const flag = r.subject as SwitchName;
    if (!SWITCH_NAMES.includes(flag) || out[flag]) continue;
    const data = (r.data ?? {}) as { new?: unknown; reason?: unknown };
    out[flag] = {
      flag,
      actorId: r.actorId,
      at: r.at,
      newValue: typeof data.new === "boolean" ? data.new : null,
      reason: typeof data.reason === "string" ? data.reason : null,
    };
  }
  return out;
}

export interface SpendSummary {
  /** Nano-USD spent by every business since 00:00 UTC. */
  readonly todayNanoUsd: number;
  /** The largest `agent_runs.cost_nano_usd` among runs started today (this business). */
  readonly largestRunTodayNanoUsd: number;
  readonly runsToday: number;
  /** Nano-USD spent since the beginning, across all businesses. */
  readonly totalNanoUsd: number;
  readonly dayStart: Date;
}

export async function spendSummary(ctx: RepoCtx, now: Date = new Date()): Promise<SpendSummary> {
  const dayStart = utcDayStartOf(now);
  const [runs] = await ctx.db
    .select({
      n: sql<number>`count(*)::int`,
      max: sql<string>`coalesce(max(${agentRuns.costNanoUsd}), 0)`,
    })
    .from(agentRuns)
    .where(
      sql`${agentRuns.businessId} = ${ctx.businessId} and ${gte(agentRuns.startedAt, dayStart)}`,
    );
  return {
    todayNanoUsd: await agentSpendSince(ctx.db, dayStart),
    totalNanoUsd: await agentSpendSince(ctx.db, new Date(0)),
    largestRunTodayNanoUsd: Number(runs?.max ?? 0),
    runsToday: runs?.n ?? 0,
    dayStart,
  };
}
