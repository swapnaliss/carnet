// Plan revisions (M3-02). Append-only: the only writer is `insertPlanRevision`, which inserts a
// revision once; there is no update or delete function, and the app role has no UPDATE or DELETE on
// `plans` or `plan_actions` (migration 0004). Tenant repository: `ctx` first, every statement scoped
// by `ctx.businessId`. Call it inside the transaction that also enqueues `plan.revised` (ADR 0005).
import { canonicalJson, type Plan, parsePlan } from "@carnet/domain";
import { and, asc, desc, eq } from "drizzle-orm";
import { PlanRevisionConflictError } from "../errors";
import { planActions, plans } from "../schema/index";
import type { RepoCtx } from "./context";

export interface StoredPlan {
  readonly id: string;
  readonly plan: Plan;
  /** What caused the revision (an outbox event id or job id), if recorded. */
  readonly trigger: string | null;
  readonly createdAt: Date;
}

type PlanRow = typeof plans.$inferSelect;
type ActionRow = typeof planActions.$inferSelect;

function toPlan(row: PlanRow, actions: readonly ActionRow[]): Plan {
  return parsePlan({
    schema_version: 1,
    business_id: row.businessId,
    revision: row.revision,
    inputs_hash: row.inputsHash,
    content_hash: row.contentHash,
    now: row.plannedAt.toISOString(),
    policy: { version: row.policyVersion, hash: row.policyHash },
    held_funds_visible_in_balances: row.heldFundsVisibleInBalances,
    actions: [...actions]
      .sort((a, b) => a.seq - b.seq)
      .map((a) => ({
        seq: a.seq,
        kind: a.kind,
        reason_code: a.reasonCode,
        reason_facts: a.reasonFacts,
        needs_approval: a.needsApproval,
        params: a.params,
      })),
  });
}

async function load(ctx: RepoCtx, row: PlanRow): Promise<StoredPlan> {
  const actions = await ctx.db
    .select()
    .from(planActions)
    .where(and(eq(planActions.planId, row.id), eq(planActions.businessId, ctx.businessId)))
    .orderBy(asc(planActions.seq));
  return { id: row.id, plan: toPlan(row, actions), trigger: row.trigger, createdAt: row.createdAt };
}

export interface InsertPlanOptions {
  /** The normalised inputs the plan was computed from (stored as canonical JSON). */
  inputs: unknown;
  trigger?: string | null;
}

/**
 * Stores `plan` as its revision. Storing the same revision again with the same `inputs_hash` is a
 * no-op that returns the stored one (`inserted: false`); the same revision number with different
 * inputs throws `PlanRevisionConflictError` (a concurrent writer; recompute from the latest).
 */
export async function insertPlanRevision(
  ctx: RepoCtx,
  plan: Plan,
  options: InsertPlanOptions,
): Promise<{ inserted: boolean; stored: StoredPlan }> {
  if (plan.business_id !== ctx.businessId) {
    throw new Error("insertPlanRevision: the plan belongs to another business");
  }
  return ctx.db.transaction(async (tx) => {
    const inner: RepoCtx = { businessId: ctx.businessId, db: tx };
    const [row] = await tx
      .insert(plans)
      .values({
        businessId: ctx.businessId,
        revision: plan.revision,
        inputsHash: plan.inputs_hash,
        contentHash: plan.content_hash,
        policyVersion: plan.policy.version,
        policyHash: plan.policy.hash,
        heldFundsVisibleInBalances: plan.held_funds_visible_in_balances,
        plannedAt: new Date(plan.now),
        trigger: options.trigger ?? null,
        inputs: JSON.parse(canonicalJson(options.inputs)) as unknown,
      })
      .onConflictDoNothing({ target: [plans.businessId, plans.revision] })
      .returning();
    if (!row) {
      const [existing] = await tx
        .select()
        .from(plans)
        .where(and(eq(plans.businessId, ctx.businessId), eq(plans.revision, plan.revision)));
      if (!existing || existing.inputsHash !== plan.inputs_hash) {
        throw new PlanRevisionConflictError(ctx.businessId, plan.revision);
      }
      return { inserted: false, stored: await load(inner, existing) };
    }
    if (plan.actions.length > 0) {
      await tx.insert(planActions).values(
        plan.actions.map((a) => ({
          planId: row.id,
          businessId: ctx.businessId,
          seq: a.seq,
          kind: a.kind,
          reasonCode: a.reason_code,
          params: a.params as unknown,
          reasonFacts: a.reason_facts as unknown,
          needsApproval: a.needs_approval,
        })),
      );
    }
    return { inserted: true, stored: await load(inner, row) };
  });
}

/** The business's highest revision, or null before the first plan. */
export async function getLatestPlan(ctx: RepoCtx): Promise<StoredPlan | null> {
  const [row] = await ctx.db
    .select()
    .from(plans)
    .where(eq(plans.businessId, ctx.businessId))
    .orderBy(desc(plans.revision))
    .limit(1);
  return row ? load(ctx, row) : null;
}

export async function getPlanByRevision(
  ctx: RepoCtx,
  revision: number,
): Promise<StoredPlan | null> {
  const [row] = await ctx.db
    .select()
    .from(plans)
    .where(and(eq(plans.businessId, ctx.businessId), eq(plans.revision, revision)));
  return row ? load(ctx, row) : null;
}

/** Revisions, newest first (for the before/after view, M3-04). */
export async function listPlanRevisions(ctx: RepoCtx, limit = 50): Promise<StoredPlan[]> {
  const rows = await ctx.db
    .select()
    .from(plans)
    .where(eq(plans.businessId, ctx.businessId))
    .orderBy(desc(plans.revision))
    .limit(Math.min(Math.max(limit, 1), 200));
  return Promise.all(rows.map((row) => load(ctx, row)));
}
