// `plan.rerun` (M3-02, ADR 0005): re-runs the pure planner for a business and stores a new revision
// only when the inputs changed. Enqueued (`enqueuePlanRerun`) by whatever changes the inputs: an
// `airwallex.transfer.updated` or `airwallex.rfi.*` event, `payment.submitted`, a balance refresh, an
// obligation change. The handler is idempotent on the event id: a replay recomputes from the same
// stored state, finds `inputs_hash` unchanged and writes nothing.
//
// The inputs come from a `PlanInputsLoader` that reads obligations, held payments, balances and the
// reserve floor. Obligations arrive with M3-01 and hold state with M2-04, so the production loader is
// supplied by `startWorker({ planInputs })`; without one `plan.rerun` is not registered.
import {
  type Db,
  getLatestPlan,
  insertPlanRevision,
  type OutboxJob,
  repoCtx,
  schema,
  withTransaction,
} from "@carnet/db";
import {
  type BusinessId,
  nextRevision,
  type Plan,
  type PlanInputs,
  type PlanInputsInput,
  parseInputs,
} from "@carnet/domain";
import { sql } from "drizzle-orm";
import {
  type HandlerContext,
  type HandlerRegistry,
  type JobHandler,
  payloadOptionalString,
  payloadString,
  registerHandler,
} from "./index";

export const PLAN_JOB_KIND = {
  rerun: "plan.rerun",
  /** Emitted in the transaction that stores a revision; M3-03 and M3-04 consume it. */
  revised: "plan.revised",
} as const;

/** Reads everything the planner needs for one business, as of `now` (the job's creation time). */
export type PlanInputsLoader = (
  db: Db,
  businessId: BusinessId,
  now: Date,
) => Promise<PlanInputsInput>;

/** Queues a re-run. `eventId` is the triggering event's id (webhook event id or job id). */
export async function enqueuePlanRerun(
  db: Db,
  input: { businessId: BusinessId; eventId: string; cause: string },
): Promise<void> {
  await db.insert(schema.outboxJobs).values({ kind: PLAN_JOB_KIND.rerun, payload: input });
}

export type PlanRerunOutcome =
  | { outcome: "revised"; revision: number }
  | { outcome: "unchanged"; revision: number | null };

export async function rerunPlan(
  ctx: Pick<HandlerContext, "db">,
  load: PlanInputsLoader,
  args: { businessId: BusinessId; eventId: string; now: Date },
): Promise<PlanRerunOutcome> {
  return withTransaction(ctx.db, async (tx) => {
    // One re-run per business at a time: revisions are numbered from the latest stored one.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`plan:${args.businessId}`}))`);
    const rc = repoCtx(tx, args.businessId);
    const latest = (await getLatestPlan(rc))?.plan ?? null;
    const fresh = await load(tx, args.businessId, args.now);

    // `now` is part of the hash, but a later clock reading alone is not a change in the facts:
    // compare against the previous plan's own `now` first.
    if (latest) {
      const same = nextRevision(latest, { ...fresh, now: latest.now });
      if (same === latest) return { outcome: "unchanged", revision: latest.revision } as const;
    }
    const parsed: PlanInputs = parseInputs(fresh);
    const next: Plan = nextRevision(latest, fresh);
    const { inserted } = await insertPlanRevision(rc, next, {
      inputs: parsed,
      trigger: args.eventId,
    });
    if (inserted) {
      await tx.insert(schema.outboxJobs).values({
        kind: PLAN_JOB_KIND.revised,
        payload: {
          businessId: args.businessId,
          revision: next.revision,
          inputsHash: next.inputs_hash,
          contentHash: next.content_hash,
          eventId: args.eventId,
        },
      });
    }
    return { outcome: "revised", revision: next.revision } as const;
  });
}

export function createPlanRerunHandler(load: PlanInputsLoader): JobHandler {
  return async (payload, ctx, job: OutboxJob) => {
    const businessId = payloadString(payload, "businessId") as BusinessId;
    const eventId = payloadOptionalString(payload, "eventId") ?? job.id;
    const result = await rerunPlan(ctx, load, { businessId, eventId, now: job.createdAt });
    ctx.logger.info({ businessId, eventId, ...result }, "plan re-run");
  };
}

/** Acknowledges `plan.revised` until M3-03 / M3-04 register their consumers. */
export const handlePlanRevised: JobHandler = async (payload, ctx) => {
  ctx.logger.info({ plan: payload }, "plan revised");
};

export function registerPlanHandlers(
  registry: HandlerRegistry,
  load: PlanInputsLoader | undefined,
): HandlerRegistry {
  registerHandler(registry, PLAN_JOB_KIND.revised, handlePlanRevised);
  if (load) registerHandler(registry, PLAN_JOB_KIND.rerun, createPlanRerunHandler(load));
  return registry;
}
