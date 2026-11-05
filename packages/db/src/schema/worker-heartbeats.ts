import { pgTable, text } from "drizzle-orm/pg-core";
import { tstz } from "./columns";

// M1-09: the worker's liveness, read by /ops and /api/ops/slo (heartbeat age). One row per worker
// process (`host:pid`), upserted every heartbeat (30 s).
export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  startedAt: tstz("started_at").notNull().defaultNow(),
  beatAt: tstz("beat_at").notNull().defaultNow(),
});
