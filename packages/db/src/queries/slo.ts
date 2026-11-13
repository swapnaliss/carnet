// SLO and health metrics computed from database timestamps (ADR 0015, M1-09). One query set serves
// the /ops page (scoped to the signed-in business for tenant tables) and the token-protected
// /api/ops/slo health check (system-wide, counts only, no identifiers).
//
// Definitions (window = the 24 h before `now` unless stated):
//   webhookAck      acked_at - received_at for events received in the window (target p95 < 300 ms)
//   jobQueue        locked_at - created_at for jobs finished DONE in the window on their first attempt
//   jobProcessing   finished_at - locked_at (last attempt) for jobs finished DONE in the window
//   queueDepth      jobs PENDING, RETRY or RUNNING now
//   deadJobs        jobs DEAD now (total) and those that became DEAD in the window
//   workerHeartbeat newest worker_heartbeats.beat_at and its age
//   reconcile       newest finished_at of a DONE `reconcile` job and its age
//   incidents       audit-log `incident.paid_then_failed` entries in the window
//   unknownAttempts execution_attempts in UNKNOWN now
// Percentiles are Postgres `percentile_cont` (linear interpolation). An empty sample is `null`
// ("no data"), never 0.

import { sql } from "drizzle-orm";
import { auditActionCountSql } from "../audit/queries";
import type { Db } from "../client";

export const SLO_WINDOW_MS = 24 * 60 * 60 * 1000;

export const SLO_TARGETS = {
  /** docs/architecture.md §9: webhook acknowledged p95 < 300 ms warm. */
  webhookAckP95Ms: 300,
  /** The worker beats every 30 s; four missed beats is down. */
  heartbeatMaxAgeMs: 120_000,
  /** Reconcile runs every 60 s; ops.md marks it stale after 3 minutes. */
  reconcileMaxAgeMs: 180_000,
} as const;

export const RECONCILE_KIND = "reconcile";
export const INCIDENT_ACTION = "incident.paid_then_failed";

export interface LatencyMetric {
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly samples: number;
}

export interface AgeMetric {
  /** ISO time, or null when none was ever recorded. */
  readonly lastAt: string | null;
  readonly ageMs: number | null;
}

export interface SloSummary {
  readonly generatedAt: string;
  readonly windowStart: string;
  readonly windowMs: number;
  readonly webhookAck: LatencyMetric & {
    readonly targetP95Ms: number;
    readonly meets: boolean | null;
    /** "no_data" when no event was acknowledged in the window (never reported as a pass). */
    readonly verdict: "meets" | "misses" | "no_data";
  };
  readonly jobQueue: LatencyMetric;
  readonly jobProcessing: LatencyMetric;
  readonly queueDepth: number;
  readonly deadJobs: { readonly total: number; readonly inWindow: number };
  readonly workerHeartbeat: AgeMetric & { readonly maxAgeMs: number };
  readonly reconcile: AgeMetric & { readonly maxAgeMs: number };
  readonly incidents: number;
  readonly unknownAttempts: number;
}

export interface SloOptions {
  now?: Date;
  windowMs?: number;
  /** Scopes the tenant tables (the audit log, execution_attempts) to one business. */
  businessId?: string;
}

type Num = number | string | null;
const num = (v: Num): number | null => (v === null ? null : Number(v));
const count = (v: Num): number => Number(v ?? 0);
const iso = (v: Date | string | null): string | null =>
  v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString();

function latency(row: { p50: Num; p95: Num; n: Num }): LatencyMetric {
  const samples = count(row.n);
  return samples === 0
    ? { p50Ms: null, p95Ms: null, samples }
    : { p50Ms: num(row.p50), p95Ms: num(row.p95), samples };
}

const ms = (a: ReturnType<typeof sql>, b: ReturnType<typeof sql>) =>
  sql`extract(epoch from (${a} - ${b})) * 1000`;

async function percentiles(db: Db, expr: ReturnType<typeof sql>, from: ReturnType<typeof sql>) {
  const res = await db.execute<{ p50: Num; p95: Num; n: Num }>(sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY v) AS p95,
           count(*) AS n
      FROM (SELECT ${expr} AS v ${from}) s`);
  const row = res.rows[0];
  return latency(row ?? { p50: null, p95: null, n: 0 });
}

export async function getSloSummary(db: Db, options: SloOptions = {}): Promise<SloSummary> {
  const now = options.now ?? new Date();
  const windowMs = options.windowMs ?? SLO_WINDOW_MS;
  const start = new Date(now.getTime() - windowMs);
  const scope = options.businessId ? sql`AND business_id = ${options.businessId}` : sql``;

  const [webhookAck, jobQueue, jobProcessing, counts] = await Promise.all([
    percentiles(
      db,
      ms(sql`acked_at`, sql`received_at`),
      sql`FROM webhook_events WHERE acked_at IS NOT NULL
            AND received_at >= ${start} AND received_at <= ${now}`,
    ),
    percentiles(
      db,
      ms(sql`locked_at`, sql`created_at`),
      sql`FROM outbox_jobs WHERE status = 'DONE' AND attempts = 1 AND locked_at IS NOT NULL
            AND finished_at >= ${start} AND finished_at <= ${now}`,
    ),
    percentiles(
      db,
      ms(sql`finished_at`, sql`locked_at`),
      sql`FROM outbox_jobs WHERE status = 'DONE' AND locked_at IS NOT NULL
            AND finished_at >= ${start} AND finished_at <= ${now}`,
    ),
    db.execute<{
      depth: Num;
      dead_total: Num;
      dead_window: Num;
      beat_at: Date | string | null;
      reconcile_at: Date | string | null;
      incidents: Num;
      unknown: Num;
    }>(sql`
      SELECT
        (SELECT count(*) FROM outbox_jobs WHERE status IN ('PENDING', 'RETRY', 'RUNNING')) AS depth,
        (SELECT count(*) FROM outbox_jobs WHERE status = 'DEAD') AS dead_total,
        (SELECT count(*) FROM outbox_jobs WHERE status = 'DEAD'
            AND finished_at >= ${start} AND finished_at <= ${now}) AS dead_window,
        (SELECT max(beat_at) FROM worker_heartbeats WHERE beat_at <= ${now}) AS beat_at,
        (SELECT max(finished_at) FROM outbox_jobs WHERE kind = ${RECONCILE_KIND}
            AND status = 'DONE' AND finished_at <= ${now}) AS reconcile_at,
        ${auditActionCountSql(INCIDENT_ACTION, start, now, scope)} AS incidents,
        (SELECT count(*) FROM execution_attempts WHERE status = 'UNKNOWN' ${scope}) AS unknown`),
  ]);
  const c = counts.rows[0];
  const age = (v: Date | string | null): AgeMetric => {
    const lastAt = iso(v ?? null);
    return { lastAt, ageMs: lastAt === null ? null : now.getTime() - Date.parse(lastAt) };
  };

  return {
    generatedAt: now.toISOString(),
    windowStart: start.toISOString(),
    windowMs,
    webhookAck: {
      ...webhookAck,
      targetP95Ms: SLO_TARGETS.webhookAckP95Ms,
      meets: webhookAck.p95Ms === null ? null : webhookAck.p95Ms < SLO_TARGETS.webhookAckP95Ms,
      verdict:
        webhookAck.p95Ms === null
          ? "no_data"
          : webhookAck.p95Ms < SLO_TARGETS.webhookAckP95Ms
            ? "meets"
            : "misses",
    },
    jobQueue,
    jobProcessing,
    queueDepth: count(c?.depth ?? 0),
    deadJobs: { total: count(c?.dead_total ?? 0), inWindow: count(c?.dead_window ?? 0) },
    workerHeartbeat: { ...age(c?.beat_at ?? null), maxAgeMs: SLO_TARGETS.heartbeatMaxAgeMs },
    reconcile: { ...age(c?.reconcile_at ?? null), maxAgeMs: SLO_TARGETS.reconcileMaxAgeMs },
    incidents: count(c?.incidents ?? 0),
    unknownAttempts: count(c?.unknown ?? 0),
  };
}

export type SloBreach =
  | "webhook_ack_p95"
  | "dead_jobs"
  | "worker_heartbeat_stale"
  | "reconcile_stale";

/**
 * What the scheduled health check fails on. "No data" for webhook ack is not a breach (no traffic);
 * a worker or reconciler that never reported is (the worker is down or was never started).
 */
export function sloBreaches(s: SloSummary): SloBreach[] {
  const out: SloBreach[] = [];
  if (s.webhookAck.meets === false) out.push("webhook_ack_p95");
  if (s.deadJobs.inWindow > 0) out.push("dead_jobs");
  if (s.workerHeartbeat.ageMs === null || s.workerHeartbeat.ageMs > s.workerHeartbeat.maxAgeMs) {
    out.push("worker_heartbeat_stale");
  }
  if (s.reconcile.ageMs === null || s.reconcile.ageMs > s.reconcile.maxAgeMs) {
    out.push("reconcile_stale");
  }
  return out;
}
