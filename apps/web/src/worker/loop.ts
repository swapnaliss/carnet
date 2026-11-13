// The worker loop (ADR 0005). Every `pollMs` it claims one due job with SELECT … FOR UPDATE SKIP
// LOCKED (packages/db `claimJobs`), runs its handler and marks it DONE; a failure is retried with
// exponential backoff and jitter (`run_after`) and becomes DEAD after `maxAttempts`, with the last
// error stored. While jobs are due it drains them without sleeping. It enqueues the reconcile job
// itself every `reconcileEveryMs` (at most one queued at a time), logs a heartbeat every
// `heartbeatMs`, prunes expired rate-limit windows every `pruneEveryMs` (M1-10), and `stop()` lets
// the in-flight job finish before `run()` resolves.
import { hostname } from "node:os";
import {
  claimJobs,
  completeJob,
  type Db,
  deferJob,
  enqueueSingletonJob,
  failJob,
  getSystemFlags,
  type OutboxJob,
  recordWorkerHeartbeat,
  verifyAndStoreAuditChain,
} from "@carnet/db";
import { type CorrelationFields, runWithContext } from "../lib/request-context";
import type { Logger } from "../server/log";
import { DEFAULT_MAX_ATTEMPTS, retryDelayMs } from "./backoff";
import type {
  AirwallexReader,
  AirwallexWriter,
  HandlerContext,
  HandlerRegistry,
} from "./handlers/index";
import { PRUNE_INTERVAL_MS, pruneExpiredRateLimits } from "./prune";
import { RECONCILE_INTERVAL_MS, RECONCILE_JOB_KIND } from "./reconcile";

export const AUDIT_VERIFY_INTERVAL_MS = 5 * 60_000;

export const DEFAULT_POLL_MS = 1_000;
export const HEARTBEAT_MS = 30_000;
/** How long a mutating job waits before it is tried again while the kill switch is off. */
export const KILL_SWITCH_DEFER_MS = 30_000;

export interface WorkerOptions {
  db: Db;
  registry: HandlerRegistry;
  airwallex: AirwallexReader;
  /** The mutating calls (M1-08); without it, mutating handlers fail their jobs. */
  airwallexWriter?: AirwallexWriter;
  logger: Logger;
  pollMs?: number;
  /** Total attempts before DEAD (OUTBOX_MAX_ATTEMPTS, default 8). */
  maxAttempts?: number;
  /** Delay before the next try after `attempt` failures. */
  backoff?: (attempt: number) => number;
  /** Null disables the self-enqueued reconcile job (tests). */
  reconcileEveryMs?: number | null;
  heartbeatMs?: number;
  /** How often expired rate-limit windows are deleted; null disables it (tests). */
  pruneEveryMs?: number | null;
  /** How often the audit chain is verified and the result stored for /ops (M4-01); null disables it. */
  auditVerifyEveryMs?: number | null;
  killSwitchDeferMs?: number;
  now?: () => number;
  /** Heartbeat row key (default `host:pid`). */
  workerId?: string;
}

/** The correlation fields of a job's log lines (M1-09): job id and kind, plus ids in its payload. */
export function jobContext(job: OutboxJob): CorrelationFields {
  const p = (typeof job.payload === "object" && job.payload !== null ? job.payload : {}) as Record<
    string,
    unknown
  >;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  const eventId = str(p.providerEventId);
  const rfiId = str(p.rfiId);
  const runId = str(p.runId);
  return {
    job_id: job.id,
    job_kind: job.kind,
    ...(eventId ? { event_id: eventId } : {}),
    ...(rfiId ? { rfi_id: rfiId } : {}),
    ...(runId ? { run_id: runId } : {}),
  };
}

export type JobOutcome = "done" | "retry" | "dead" | "deferred";

export interface Worker {
  /** Runs until `stop()`; resolves after the in-flight job (if any) has finished. */
  run(): Promise<void>;
  stop(): void;
  /** Claims and runs at most one job. Returns its outcome, or null when nothing was due. */
  tick(): Promise<{ job: OutboxJob; outcome: JobOutcome } | null>;
  readonly stats: { processed: number; failed: number; deferred: number };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function createWorker(options: WorkerOptions): Worker {
  const { db, registry, logger } = options;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const backoff = options.backoff ?? ((attempt: number) => retryDelayMs(attempt));
  const reconcileEveryMs =
    options.reconcileEveryMs === undefined ? RECONCILE_INTERVAL_MS : options.reconcileEveryMs;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const pruneEveryMs =
    options.pruneEveryMs === undefined ? PRUNE_INTERVAL_MS : options.pruneEveryMs;
  const auditVerifyEveryMs =
    options.auditVerifyEveryMs === undefined
      ? AUDIT_VERIFY_INTERVAL_MS
      : options.auditVerifyEveryMs;
  const deferMs = options.killSwitchDeferMs ?? KILL_SWITCH_DEFER_MS;
  const now = options.now ?? Date.now;
  const workerId = options.workerId ?? `${hostname()}:${process.pid}`;
  const ctx: HandlerContext = {
    db,
    airwallex: options.airwallex,
    ...(options.airwallexWriter ? { airwallexWriter: options.airwallexWriter } : {}),
    logger,
  };
  const stats = { processed: 0, failed: 0, deferred: 0 };

  let stopping = false;
  let wake: (() => void) | null = null;
  let nextReconcileAt = 0;
  let nextPruneAt = 0;
  let nextAuditVerifyAt = 0;
  let nextHeartbeatAt = 0;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  async function executionEnabled(): Promise<boolean> {
    try {
      return (await getSystemFlags(db)).executionEnabled;
    } catch (error) {
      // A missing flags row or an unreadable one means "disabled" (packages/db SystemFlagsMissingError).
      logger.warn(
        { error: errorText(error) },
        "system flags unreadable; treating execution as disabled",
      );
      return false;
    }
  }

  async function execute(job: OutboxJob): Promise<JobOutcome> {
    const def = registry.get(job.kind);
    if (!def) {
      await failJob(db, job.id, {
        error: `no handler registered for job kind ${job.kind}`,
        runAfter: new Date(now()),
        dead: true,
      });
      logger.error({ jobId: job.id, kind: job.kind }, "job has no handler; marked DEAD");
      stats.failed += 1;
      return "dead";
    }
    if (def.mutating && !(await executionEnabled())) {
      await deferJob(
        db,
        job.id,
        new Date(now() + deferMs),
        "deferred: execution disabled (kill switch)",
      );
      logger.warn({ jobId: job.id, kind: job.kind }, "execution disabled; mutating job deferred");
      stats.deferred += 1;
      return "deferred";
    }
    const started = now();
    try {
      await def.handle(job.payload, ctx, job);
      await completeJob(db, job.id);
      stats.processed += 1;
      logger.debug({ jobId: job.id, kind: job.kind, ms: now() - started }, "job done");
      return "done";
    } catch (error) {
      const dead = job.attempts >= maxAttempts;
      const delay = backoff(job.attempts);
      await failJob(db, job.id, {
        error: errorText(error),
        runAfter: new Date(now() + delay),
        dead,
      });
      stats.failed += 1;
      const fields = {
        jobId: job.id,
        kind: job.kind,
        attempts: job.attempts,
        maxAttempts,
        error: errorText(error),
      };
      if (dead) logger.error(fields, "job failed; retry limit reached, marked DEAD");
      else logger.warn({ ...fields, retryInMs: delay }, "job failed; will retry");
      return dead ? "dead" : "retry";
    }
  }

  async function tick(): Promise<{ job: OutboxJob; outcome: JobOutcome } | null> {
    const [job] = await claimJobs(db, { limit: 1 });
    if (!job) return null;
    return { job, outcome: await runWithContext(jobContext(job), () => execute(job)) };
  }

  async function housekeeping(): Promise<void> {
    const t = now();
    if (t >= nextHeartbeatAt) {
      nextHeartbeatAt = t + heartbeatMs;
      // Stored for /ops and the health check (M1-09); a failed write is logged, never fatal.
      await recordWorkerHeartbeat(db, workerId).catch((error: unknown) =>
        logger.warn({ error: errorText(error) }, "worker heartbeat not recorded"),
      );
      logger.info({ heartbeat: true, ...stats }, "worker heartbeat");
    }
    if (reconcileEveryMs !== null && t >= nextReconcileAt) {
      nextReconcileAt = t + reconcileEveryMs;
      const id = await enqueueSingletonJob(db, { kind: RECONCILE_JOB_KIND, payload: {} });
      if (id) logger.debug({ jobId: id }, "reconcile job enqueued");
    }
    if (auditVerifyEveryMs !== null && t >= nextAuditVerifyAt) {
      nextAuditVerifyAt = t + auditVerifyEveryMs;
      try {
        const r = await verifyAndStoreAuditChain(db);
        if (r.ok) logger.debug({ checked: r.checked }, "audit chain verified");
        else
          logger.error(
            { event: "audit.chain.broken", reason: r.reason, firstBadId: String(r.firstBadId) },
            "audit chain verification FAILED",
          );
      } catch (error) {
        logger.warn({ error: errorText(error) }, "audit chain verification did not run");
      }
    }
    if (pruneEveryMs !== null && t >= nextPruneAt) {
      nextPruneAt = t + pruneEveryMs;
      const pruned = await pruneExpiredRateLimits(db, t);
      if (pruned > 0) logger.debug({ pruned }, "expired rate-limit windows pruned");
    }
  }

  async function run(): Promise<void> {
    logger.info({ pollMs, maxAttempts, reconcileEveryMs }, "worker started");
    while (!stopping) {
      try {
        await housekeeping();
        const result = await tick();
        if (!result && !stopping) await sleep(pollMs);
      } catch (error) {
        logger.error({ error: errorText(error) }, "worker loop error");
        if (!stopping) await sleep(pollMs);
      }
    }
    logger.info({ ...stats }, "worker stopped");
  }

  function stop(): void {
    stopping = true;
    wake?.();
  }

  return { run, stop, tick, stats };
}
