// Worker liveness (M1-09). System-level: takes `db`, not a tenant context.
import { sql } from "drizzle-orm";
import type { Db } from "../client";
import { workerHeartbeats } from "../schema/index";

/** Upserts this worker's heartbeat (`beat_at = now()`); `started_at` is kept from the first beat. */
export async function recordWorkerHeartbeat(db: Db, workerId: string): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({ workerId })
    .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { beatAt: sql`now()` } });
}
