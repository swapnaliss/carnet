// Outbox claim and settlement (ADR 0005, M1-05). System-level: takes `db`, not a tenant context.
// A job is claimed with FOR UPDATE SKIP LOCKED and flipped to RUNNING in the same statement, so two
// workers never receive the same job. A RUNNING job whose lease ran out (a crashed worker) becomes
// claimable again; handlers are idempotent, so a rerun after a crash is safe.
import { eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import { type JobStatus, outboxJobs } from "../schema/index";

export interface OutboxJob {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly status: JobStatus;
  /** Attempts started so far, including the current one once claimed. */
  readonly attempts: number;
  readonly runAfter: Date;
  readonly lockedAt: Date | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
}

/** A RUNNING job older than this is treated as abandoned and claimed again. */
export const DEFAULT_JOB_LEASE_MS = 5 * 60 * 1000;

type RawJobRow = Record<string, unknown> & {
  id: string;
  kind: string;
  payload: unknown;
  status: JobStatus;
  attempts: number;
  run_after: Date | string;
  locked_at: Date | string | null;
  last_error: string | null;
  created_at: Date | string;
};

const asDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

function fromRaw(r: RawJobRow): OutboxJob {
  return {
    id: r.id,
    kind: r.kind,
    payload: r.payload,
    status: r.status,
    attempts: Number(r.attempts),
    runAfter: asDate(r.run_after),
    lockedAt: r.locked_at === null ? null : asDate(r.locked_at),
    lastError: r.last_error,
    createdAt: asDate(r.created_at),
  };
}

export interface ClaimOptions {
  /** Most jobs to claim (default 1). */
  limit?: number;
  /** Lease for RUNNING jobs, ms (default DEFAULT_JOB_LEASE_MS). */
  leaseMs?: number;
}

/**
 * Claims due jobs (PENDING or RETRY with run_after <= now, or RUNNING past its lease) and marks them
 * RUNNING with attempts + 1. Oldest run_after first.
 */
export async function claimJobs(db: Db, options: ClaimOptions = {}): Promise<OutboxJob[]> {
  const limit = Math.min(Math.max(options.limit ?? 1, 1), 100);
  const leaseSeconds = (options.leaseMs ?? DEFAULT_JOB_LEASE_MS) / 1000;
  const result = await db.execute<RawJobRow>(sql`
    UPDATE outbox_jobs AS j
       SET status = 'RUNNING', locked_at = now(), attempts = j.attempts + 1
     WHERE j.id IN (
       SELECT id FROM outbox_jobs
        WHERE (status IN ('PENDING', 'RETRY') AND run_after <= now())
           OR (status = 'RUNNING' AND locked_at < now() - make_interval(secs => ${leaseSeconds}))
        ORDER BY run_after, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING j.id, j.kind, j.payload, j.status, j.attempts, j.run_after, j.locked_at,
              j.last_error, j.created_at`);
  return result.rows.map(fromRaw);
}

/** Marks a claimed job DONE. */
export async function completeJob(db: Db, id: string): Promise<void> {
  await db
    .update(outboxJobs)
    .set({ status: "DONE", lockedAt: null, lastError: null })
    .where(eq(outboxJobs.id, id));
}

export interface JobFailure {
  error: string;
  /** Next attempt time for RETRY; ignored when `dead`. */
  runAfter: Date;
  dead: boolean;
}

/** Records a failed attempt: RETRY at `runAfter`, or DEAD. The error is stored either way. */
export async function failJob(db: Db, id: string, failure: JobFailure): Promise<void> {
  await db
    .update(outboxJobs)
    .set({
      status: failure.dead ? "DEAD" : "RETRY",
      lockedAt: null,
      lastError: failure.error.slice(0, 4000),
      ...(failure.dead ? {} : { runAfter: failure.runAfter }),
    })
    .where(eq(outboxJobs.id, id));
}

/**
 * Puts a claimed job back without counting the attempt (for example the kill switch is off). It
 * becomes due again at `runAfter`.
 */
export async function deferJob(db: Db, id: string, runAfter: Date, reason: string): Promise<void> {
  await db
    .update(outboxJobs)
    .set({
      status: "PENDING",
      lockedAt: null,
      runAfter,
      lastError: reason.slice(0, 4000),
      attempts: sql`greatest(${outboxJobs.attempts} - 1, 0)`,
    })
    .where(eq(outboxJobs.id, id));
}

export async function getJob(db: Db, id: string): Promise<OutboxJob | null> {
  const [row] = await db.select().from(outboxJobs).where(eq(outboxJobs.id, id));
  return row ?? null;
}

/**
 * Enqueues a job of `kind` unless one is already PENDING, RETRY or RUNNING. Serialised with a
 * transaction-scoped advisory lock, so concurrent workers enqueue at most one. Returns the new job
 * id, or null when one was already queued.
 */
export async function enqueueSingletonJob(
  db: Db,
  job: { kind: string; payload: unknown; runAfter?: Date },
): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`outbox:${job.kind}`}))`);
    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id FROM outbox_jobs
       WHERE kind = ${job.kind} AND status IN ('PENDING', 'RETRY', 'RUNNING')
       LIMIT 1`);
    if (existing.rows.length > 0) return null;
    const [row] = await tx
      .insert(outboxJobs)
      .values({
        kind: job.kind,
        payload: job.payload,
        ...(job.runAfter ? { runAfter: job.runAfter } : {}),
      })
      .returning({ id: outboxJobs.id });
    return row?.id ?? null;
  });
}
