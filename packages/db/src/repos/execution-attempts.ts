import { type AttemptId, type BusinessId, newAttemptId, type RequestId } from "@carnet/domain";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { DuplicateRequestIdError, pgErrorOf, translateDbError } from "../errors";
import { type AttemptKind, type AttemptStatus, executionAttempts } from "../schema/index";
import type { RepoCtx } from "./context";
import { assertExecutionEnabled } from "./system";

export interface ExecutionAttempt {
  readonly id: AttemptId;
  readonly businessId: BusinessId;
  readonly kind: AttemptKind;
  /** The payment, conversion or RFI this attempt executes. */
  readonly refId: string;
  readonly requestId: RequestId;
  readonly status: AttemptStatus;
  readonly response: unknown;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

type Row = typeof executionAttempts.$inferSelect;
export const toAttempt = (r: Row): ExecutionAttempt => ({
  id: r.id as AttemptId,
  businessId: r.businessId as BusinessId,
  kind: r.kind,
  refId: r.refId,
  requestId: r.requestId as RequestId,
  status: r.status,
  response: r.response ?? null,
  createdAt: r.createdAt,
  resolvedAt: r.resolvedAt,
});

export interface NewAttempt {
  id?: AttemptId;
  kind: AttemptKind;
  refId: string;
  /** Minted once per intent (`newRequestId()`), reused only to retry the same operation. */
  requestId: RequestId;
}

/** Inserts an INTENT attempt. Throws DuplicateRequestIdError if the request_id is taken. */
export async function createAttempt(ctx: RepoCtx, input: NewAttempt): Promise<ExecutionAttempt> {
  // Kill switch (M4-02): no new attempt of any kind while execution is off. Resolving an existing
  // attempt (reconciler, claim, status updates) never goes through here.
  await assertExecutionEnabled(ctx.db);
  try {
    const [row] = await ctx.db
      .insert(executionAttempts)
      .values({
        id: input.id ?? newAttemptId(),
        businessId: ctx.businessId,
        kind: input.kind,
        refId: input.refId,
        requestId: input.requestId,
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return toAttempt(row);
  } catch (error) {
    const pgError = pgErrorOf(error);
    if (pgError?.code === "23505" && pgError.constraint === "execution_attempts_request_id_key") {
      throw new DuplicateRequestIdError(input.requestId);
    }
    throw translateDbError(error);
  }
}

export async function getAttempt(ctx: RepoCtx, id: AttemptId): Promise<ExecutionAttempt | null> {
  const [row] = await ctx.db
    .select()
    .from(executionAttempts)
    .where(and(eq(executionAttempts.businessId, ctx.businessId), eq(executionAttempts.id, id)));
  return row ? toAttempt(row) : null;
}

export async function getAttemptByRequestId(
  ctx: RepoCtx,
  requestId: RequestId,
): Promise<ExecutionAttempt | null> {
  const [row] = await ctx.db
    .select()
    .from(executionAttempts)
    .where(
      and(
        eq(executionAttempts.businessId, ctx.businessId),
        eq(executionAttempts.requestId, requestId),
      ),
    );
  return row ? toAttempt(row) : null;
}

/** The attempts of one kind for these payments (or conversions, RFIs), oldest first (M1-08). */
export async function listAttemptsForRefs(
  ctx: RepoCtx,
  kind: AttemptKind,
  refIds: readonly string[],
): Promise<ExecutionAttempt[]> {
  if (refIds.length === 0) return [];
  const rows = await ctx.db
    .select()
    .from(executionAttempts)
    .where(
      and(
        eq(executionAttempts.businessId, ctx.businessId),
        eq(executionAttempts.kind, kind),
        inArray(executionAttempts.refId, [...refIds]),
      ),
    )
    .orderBy(asc(executionAttempts.createdAt), asc(executionAttempts.id));
  return rows.map(toAttempt);
}

const TERMINAL: readonly AttemptStatus[] = ["CONFIRMED", "REJECTED"];

export async function updateAttemptStatus(
  ctx: RepoCtx,
  id: AttemptId,
  status: AttemptStatus,
  response?: unknown,
): Promise<ExecutionAttempt | null> {
  const [row] = await ctx.db
    .update(executionAttempts)
    .set({
      status,
      ...(response === undefined ? {} : { response }),
      resolvedAt: TERMINAL.includes(status) ? new Date() : null,
    })
    .where(and(eq(executionAttempts.businessId, ctx.businessId), eq(executionAttempts.id, id)))
    .returning();
  return row ? toAttempt(row) : null;
}

/**
 * Takes the right to run an attempt: one executor at a time (M2-07). Compare-and-set on a lease kept in
 * the attempt's `response` (`leaseUntil`): it succeeds only when no unexpired lease is held and the
 * attempt is in one of `statuses`, and returns the attempt as claimed. `null` means another executor
 * holds it (or the attempt moved on). A crashed executor's lease lapses; a resolved attempt needs none.
 */
export async function claimAttempt(
  ctx: RepoCtx,
  id: AttemptId,
  statuses: readonly AttemptStatus[],
  leaseMs: number,
): Promise<ExecutionAttempt | null> {
  const until = new Date(Date.now() + leaseMs).toISOString();
  const [row] = await ctx.db
    .update(executionAttempts)
    .set({
      response: sql`jsonb_set(coalesce(${executionAttempts.response}, '{}'::jsonb), '{leaseUntil}', to_jsonb(${until}::text))`,
    })
    .where(
      and(
        eq(executionAttempts.businessId, ctx.businessId),
        eq(executionAttempts.id, id),
        inArray(executionAttempts.status, [...statuses]),
        sql`(${executionAttempts.response} ->> 'leaseUntil' is null or (${executionAttempts.response} ->> 'leaseUntil')::timestamptz <= now())`,
      ),
    )
    .returning();
  return row ? toAttempt(row) : null;
}

/** Gives a claimed attempt back (the executor failed before it could record an outcome). */
export async function releaseAttempt(ctx: RepoCtx, id: AttemptId): Promise<void> {
  await ctx.db
    .update(executionAttempts)
    .set({ response: sql`${executionAttempts.response} - 'leaseUntil'` })
    .where(
      and(
        eq(executionAttempts.businessId, ctx.businessId),
        eq(executionAttempts.id, id),
        inArray(executionAttempts.status, ["INTENT", "SENT_TO_AIRWALLEX", "UNKNOWN"]),
      ),
    );
}
