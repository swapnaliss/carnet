// M4-05 (ADR 0018 amendment 2): replay mode, the session's mode, per-session model spend, the
// demo-database marker and the replay recording index. System repositories (db first): the replay
// business is a fixed tenant, and a session row is not tenant-scoped.
import type { BusinessId } from "@carnet/domain";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import { agentRuns } from "../schema/agent";
import { authSessions, type SessionMode } from "../schema/auth";
import { demoDatabase, replayRecordings } from "../schema/replay";

/** Sets a session's mode. Returns false when the session does not exist. */
export async function setSessionMode(
  db: Db,
  sessionId: string,
  mode: SessionMode,
): Promise<boolean> {
  const rows = await db
    .update(authSessions)
    .set({ mode })
    .where(eq(authSessions.id, sessionId))
    .returning({ id: authSessions.id });
  return rows.length === 1;
}

/** Cost (nano-USD) of every model run queued by this web session. Durable: a restart keeps it. */
export async function sessionModelSpendNanoUsd(db: Db, sessionId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${agentRuns.costNanoUsd}), 0)` })
    .from(agentRuns)
    .where(eq(agentRuns.sessionId, sessionId));
  return Number(row?.total ?? 0);
}

/** True when the demo-database marker row exists (migration 0019). */
export async function isDemoDatabase(db: Db): Promise<boolean> {
  try {
    const rows = await db.select({ id: demoDatabase.id }).from(demoDatabase).limit(1);
    return rows.length === 1;
  } catch {
    return false;
  }
}

export interface ReplayRecordingRow {
  readonly id: string;
  readonly businessId: BusinessId;
  readonly position: number;
  readonly manifest: unknown;
  readonly timeline: unknown;
  readonly refs: Record<string, string>;
  readonly materialized: boolean;
}

export async function listReplayRecordings(db: Db): Promise<ReplayRecordingRow[]> {
  const rows = await db.select().from(replayRecordings).orderBy(asc(replayRecordings.position));
  return rows.map((r) => ({
    id: r.id,
    businessId: r.businessId as BusinessId,
    position: r.position,
    manifest: r.manifest,
    timeline: r.timeline,
    refs: r.refs,
    materialized: r.materialized,
  }));
}

/** Replaces the whole index (the demo reset owns it). */
export async function replaceReplayRecordings(
  db: Db,
  rows: readonly Omit<ReplayRecordingRow, "businessId">[],
  businessId: BusinessId,
): Promise<void> {
  await db.delete(replayRecordings);
  if (rows.length === 0) return;
  await db.insert(replayRecordings).values(
    rows.map((r) => ({
      id: r.id,
      businessId,
      position: r.position,
      manifest: r.manifest,
      timeline: r.timeline,
      refs: r.refs,
      materialized: r.materialized,
    })),
  );
}

/**
 * The business replay sessions read: the last materialized recording in the index (the newest run
 * covers the most), or null before any reset has loaded one.
 */
export async function activeReplayBusinessId(db: Db): Promise<BusinessId | null> {
  const [row] = await db
    .select({ businessId: replayRecordings.businessId })
    .from(replayRecordings)
    .where(eq(replayRecordings.materialized, true))
    .orderBy(desc(replayRecordings.position))
    .limit(1);
  return (row?.businessId ?? null) as BusinessId | null;
}
