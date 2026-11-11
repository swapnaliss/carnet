// Plan actions at execution time (M3-03). `plan_actions` rows never change, so an action's life
// (PROPOSED, APPROVED, AUTO_APPROVED, EXECUTING, DONE, FAILED, SUPERSEDED) is kept in
// `plan_action_states`, moved only by compare-and-set. No row means PROPOSED.
import { type PlanAction, parsePlan } from "@carnet/domain";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { type ActionState, approvals, planActionStates, planActions, plans } from "../schema/index";
import type { RepoCtx } from "./context";

export interface StoredAction {
  readonly id: string;
  readonly planId: string;
  readonly revision: number;
  readonly planContentHash: string;
  readonly action: PlanAction;
  readonly state: ActionState;
  readonly stateReason: string | null;
  readonly attemptId: string | null;
}

type Joined = {
  a: typeof planActions.$inferSelect;
  p: typeof plans.$inferSelect;
  s: typeof planActionStates.$inferSelect | null;
};

function toStored(j: Joined): StoredAction {
  // Re-use the plan parser so the action is validated exactly as a stored plan is.
  const plan = parsePlan({
    schema_version: 1,
    business_id: j.p.businessId,
    revision: j.p.revision,
    inputs_hash: j.p.inputsHash,
    content_hash: j.p.contentHash,
    now: j.p.plannedAt.toISOString(),
    policy: { version: j.p.policyVersion, hash: j.p.policyHash },
    held_funds_visible_in_balances: j.p.heldFundsVisibleInBalances,
    actions: [
      {
        seq: j.a.seq,
        kind: j.a.kind,
        reason_code: j.a.reasonCode,
        reason_facts: j.a.reasonFacts,
        needs_approval: j.a.needsApproval,
        params: j.a.params,
      },
    ],
  });
  const action = plan.actions[0];
  if (!action) throw new Error("stored action did not parse");
  return {
    id: j.a.id,
    planId: j.p.id,
    revision: j.p.revision,
    planContentHash: j.p.contentHash,
    action,
    state: (j.s?.status ?? "PROPOSED") as ActionState,
    stateReason: j.s?.reason ?? null,
    attemptId: j.s?.attemptId ?? null,
  };
}

const selectJoined = (ctx: RepoCtx) =>
  ctx.db
    .select({ a: planActions, p: plans, s: planActionStates })
    .from(planActions)
    .innerJoin(plans, and(eq(plans.id, planActions.planId), eq(plans.businessId, ctx.businessId)))
    .leftJoin(planActionStates, eq(planActionStates.actionId, planActions.id));

/** One stored action with its state, or null when it is another business's or does not exist. */
export async function getStoredAction(
  ctx: RepoCtx,
  actionId: string,
): Promise<StoredAction | null> {
  const [row] = await selectJoined(ctx).where(
    and(eq(planActions.id, actionId), eq(planActions.businessId, ctx.businessId)),
  );
  return row ? toStored(row) : null;
}

/** The actions of one plan revision in sequence order. */
export async function listStoredActions(ctx: RepoCtx, planId: string): Promise<StoredAction[]> {
  const rows = await selectJoined(ctx)
    .where(and(eq(planActions.planId, planId), eq(planActions.businessId, ctx.businessId)))
    .orderBy(asc(planActions.seq));
  return rows.map(toStored);
}

/** The id of the newest plan revision of the business, or null. */
export async function latestPlanId(ctx: RepoCtx): Promise<string | null> {
  const [row] = await ctx.db
    .select({ id: plans.id })
    .from(plans)
    .where(eq(plans.businessId, ctx.businessId))
    .orderBy(desc(plans.revision))
    .limit(1);
  return row?.id ?? null;
}

export interface TransitionOptions {
  reason?: string | null;
  attemptId?: string | null;
}

/**
 * Moves an action from one of `from` to `to` in one statement; false when it was not in a `from`
 * state (another executor moved it, or it was superseded). `PROPOSED` in `from` also matches an
 * action that has no state row yet.
 */
export async function transitionAction(
  ctx: RepoCtx,
  actionId: string,
  from: readonly ActionState[],
  to: ActionState,
  options: TransitionOptions = {},
): Promise<boolean> {
  const set = {
    status: to,
    reason: options.reason ?? null,
    ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId }),
    updatedAt: sql`now()`,
  };
  if (from.includes("PROPOSED")) {
    const rows = await ctx.db
      .insert(planActionStates)
      .values({
        actionId,
        businessId: ctx.businessId,
        status: to,
        reason: options.reason ?? null,
        attemptId: options.attemptId ?? null,
      })
      .onConflictDoUpdate({
        target: planActionStates.actionId,
        set,
        setWhere: sql`${planActionStates.businessId} = ${ctx.businessId} AND ${planActionStates.status} IN (${sql.join(
          from.map((f) => sql`${f}`),
          sql`, `,
        )})`,
      })
      .returning({ actionId: planActionStates.actionId });
    return rows.length > 0;
  }
  const rows = await ctx.db
    .update(planActionStates)
    .set(set)
    .where(
      and(
        eq(planActionStates.actionId, actionId),
        eq(planActionStates.businessId, ctx.businessId),
        inArray(planActionStates.status, [...from]),
      ),
    )
    .returning({ actionId: planActionStates.actionId });
  return rows.length > 0;
}

/** Records why a PROPOSED action is not moving (a policy denial) without changing its state. */
export async function noteAction(ctx: RepoCtx, actionId: string, reason: string): Promise<void> {
  await ctx.db
    .insert(planActionStates)
    .values({ actionId, businessId: ctx.businessId, status: "PROPOSED", reason })
    .onConflictDoUpdate({
      target: planActionStates.actionId,
      set: { reason, updatedAt: sql`now()` },
      setWhere: sql`${planActionStates.businessId} = ${ctx.businessId} AND ${planActionStates.status} = 'PROPOSED'`,
    });
}

/**
 * A new plan revision arrived: actions of earlier revisions that are not yet APPROVED or EXECUTING
 * (PROPOSED, or AUTO_APPROVED with nothing sent) are SUPERSEDED, and any live conversion approval
 * bound to them is ended (REJECTED, SUPERSEDED), so it can no longer be consumed. Returns the ids.
 */
export async function supersedeStaleActions(ctx: RepoCtx, newPlanId: string): Promise<string[]> {
  const [fresh] = await ctx.db
    .select({ revision: plans.revision })
    .from(plans)
    .where(and(eq(plans.id, newPlanId), eq(plans.businessId, ctx.businessId)));
  if (!fresh) return [];
  const older = await ctx.db
    .select({ id: planActions.id, status: planActionStates.status })
    .from(planActions)
    .innerJoin(plans, eq(plans.id, planActions.planId))
    .leftJoin(planActionStates, eq(planActionStates.actionId, planActions.id))
    .where(and(eq(planActions.businessId, ctx.businessId), lt(plans.revision, fresh.revision)));
  const stale = older
    .filter((r) => r.status === null || r.status === "PROPOSED" || r.status === "AUTO_APPROVED")
    .map((r) => r.id);
  const done: string[] = [];
  for (const id of stale) {
    const moved = await transitionAction(ctx, id, ["PROPOSED", "AUTO_APPROVED"], "SUPERSEDED", {
      reason: "SUPERSEDED",
    });
    if (moved) done.push(id);
  }
  if (done.length > 0) {
    await ctx.db
      .update(approvals)
      .set({ status: "REJECTED", endReason: "SUPERSEDED", updatedAt: sql`now()` })
      .where(
        and(
          eq(approvals.businessId, ctx.businessId),
          eq(approvals.kind, "conversion"),
          inArray(approvals.subjectRef, done),
          inArray(approvals.status, ["PENDING", "APPROVED"]),
        ),
      );
  }
  return done;
}

/**
 * Whether the action still belongs to the current plan: it is in the newest revision, or the newest
 * revision holds an action of the same kind with identical parameters (the replan kept it).
 */
export async function isActionCurrent(ctx: RepoCtx, stored: StoredAction): Promise<boolean> {
  const latest = await latestPlanId(ctx);
  if (latest === null) return false;
  if (latest === stored.planId) return true;
  const rows = await listStoredActions(ctx, latest);
  const key = JSON.stringify([stored.action.kind, sortedParams(stored.action.params)]);
  return rows.some((r) => JSON.stringify([r.action.kind, sortedParams(r.action.params)]) === key);
}

function sortedParams(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedParams);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortedParams(v)]),
    );
  }
  return value;
}
