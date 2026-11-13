// Circuit breakers (architecture §9, M4-02). The state of a dependency is a pure function of its
// recent outcomes, and the outcomes are database rows (outbox_jobs for Airwallex, agent_steps for the
// model), so two worker instances read the same state and a restart forgets nothing. There is no
// counter in memory: nothing in this file holds state between calls.
//
//   CLOSED     fewer than `failureThreshold` failures inside the window, or a success after the last
//              failure
//   OPEN       at least `failureThreshold` failures inside the window, the last one younger than
//              `coolDownMs`, and no success since
//   HALF_OPEN  the cool-down has passed with no success: one probe is allowed; its success closes the
//              breaker, its failure restarts the cool-down
import { and, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "./client";
import { agentSteps, outboxJobs } from "./schema/index";

export type Dependency = "airwallex" | "model";
export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface BreakerConfig {
  readonly failureThreshold: number;
  readonly windowMs: number;
  readonly coolDownMs: number;
}

export const DEFAULT_BREAKER_CONFIG: BreakerConfig = {
  failureThreshold: 5,
  windowMs: 5 * 60_000,
  coolDownMs: 60_000,
};

/** Reads `BREAKER_FAILURE_THRESHOLD`, `BREAKER_WINDOW_SECONDS`, `BREAKER_COOLDOWN_SECONDS`. */
export function breakerConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): BreakerConfig {
  const int = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    failureThreshold: int(env.BREAKER_FAILURE_THRESHOLD, DEFAULT_BREAKER_CONFIG.failureThreshold),
    windowMs: int(env.BREAKER_WINDOW_SECONDS, DEFAULT_BREAKER_CONFIG.windowMs / 1000) * 1000,
    coolDownMs: int(env.BREAKER_COOLDOWN_SECONDS, DEFAULT_BREAKER_CONFIG.coolDownMs / 1000) * 1000,
  };
}

export interface DependencyOutcome {
  readonly at: Date;
  readonly ok: boolean;
}

export interface BreakerView {
  readonly dependency: Dependency;
  readonly state: BreakerState;
  readonly failuresInWindow: number;
  readonly lastFailureAt: Date | null;
  /** While OPEN: when the cool-down ends and a probe is allowed. */
  readonly retryAt: Date | null;
}

/** The pure rule. `outcomes` may arrive in any order and may include rows older than the window. */
export function deriveBreaker(
  dependency: Dependency,
  outcomes: readonly DependencyOutcome[],
  config: BreakerConfig,
  now: Date,
): BreakerView {
  const from = now.getTime() - config.windowMs;
  const recent = outcomes.filter((o) => o.at.getTime() >= from && o.at.getTime() <= now.getTime());
  const failures = recent.filter((o) => !o.ok);
  const lastFailure = failures.reduce<Date | null>(
    (latest, o) => (latest === null || o.at > latest ? o.at : latest),
    null,
  );
  const lastSuccess = recent
    .filter((o) => o.ok)
    .reduce<Date | null>((latest, o) => (latest === null || o.at > latest ? o.at : latest), null);
  const view = (state: BreakerState, retryAt: Date | null = null): BreakerView => ({
    dependency,
    state,
    failuresInWindow: failures.length,
    lastFailureAt: lastFailure,
    retryAt,
  });
  if (lastFailure === null || failures.length < config.failureThreshold) return view("CLOSED");
  if (lastSuccess !== null && lastSuccess > lastFailure) return view("CLOSED");
  const retryAt = new Date(lastFailure.getTime() + config.coolDownMs);
  return now >= retryAt ? view("HALF_OPEN") : view("OPEN", retryAt);
}

/** Job kinds that call Airwallex. `reconcile` is deliberately absent: it only looks up and must run. */
export const AIRWALLEX_JOB_KINDS = [
  "transfer.sync",
  "rfi.sync",
  "rfi.respond",
  "transfer.create",
  "transfer.simulate",
] as const;

/** Job kinds that make model calls (extraction and drafting). */
export const MODEL_JOB_KINDS = ["document.extract", "rfi.draft"] as const;

/** The dependency a job depends on, or null (the reconciler and pure-code jobs are never paused). */
export function dependencyOfJobKind(kind: string): Dependency | null {
  if ((AIRWALLEX_JOB_KINDS as readonly string[]).includes(kind)) return "airwallex";
  if ((MODEL_JOB_KINDS as readonly string[]).includes(kind)) return "model";
  return null;
}

async function airwallexOutcomes(db: Db, since: Date): Promise<DependencyOutcome[]> {
  const at = sql<Date>`coalesce(${outboxJobs.finishedAt}, ${outboxJobs.lockedAt})`;
  const rows = await db
    .select({ status: outboxJobs.status, at })
    .from(outboxJobs)
    .where(
      and(
        inArray(outboxJobs.kind, [...AIRWALLEX_JOB_KINDS]),
        inArray(outboxJobs.status, ["DONE", "RETRY", "DEAD"]),
        sql`${at} >= ${since}`,
      ),
    );
  return rows.map((r) => ({ at: new Date(r.at), ok: r.status === "DONE" }));
}

async function modelOutcomes(db: Db, since: Date): Promise<DependencyOutcome[]> {
  const rows = await db
    .select({ outcome: agentSteps.outcome, at: agentSteps.createdAt })
    .from(agentSteps)
    .where(
      and(
        gte(agentSteps.createdAt, since),
        inArray(agentSteps.outcome, ["ok", "refused", "truncated", "provider_error"]),
      ),
    );
  return rows.map((r) => ({ at: r.at, ok: r.outcome !== "provider_error" }));
}

/** Reads the dependency's recent rows and applies the rule. Safe to call from any instance. */
export async function readBreaker(
  db: Db,
  dependency: Dependency,
  config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
  now: Date = new Date(),
): Promise<BreakerView> {
  const since = new Date(now.getTime() - config.windowMs);
  const outcomes =
    dependency === "airwallex"
      ? await airwallexOutcomes(db, since)
      : await modelOutcomes(db, since);
  return deriveBreaker(dependency, outcomes, config, now);
}

export async function readBreakers(
  db: Db,
  config: BreakerConfig = DEFAULT_BREAKER_CONFIG,
  now: Date = new Date(),
): Promise<BreakerView[]> {
  return Promise.all([
    readBreaker(db, "airwallex", config, now),
    readBreaker(db, "model", config, now),
  ]);
}
