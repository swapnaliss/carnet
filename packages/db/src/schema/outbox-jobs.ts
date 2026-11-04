import { check, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, oneOf, tstz } from "./columns";

export const JOB_STATUSES = ["PENDING", "RUNNING", "DONE", "RETRY", "DEAD"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// ADR 0005: written in the same transaction as the state change; claimed with SKIP LOCKED (M1-05).
export const outboxJobs = pgTable(
  "outbox_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    status: text("status").$type<JobStatus>().notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: tstz("run_after").notNull().defaultNow(),
    lockedAt: tstz("locked_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    // M1-09: set when the job becomes DONE or DEAD (processing time = finished_at - locked_at).
    finishedAt: tstz("finished_at"),
  },
  (t) => [
    index("outbox_jobs_status_run_after_idx").on(t.status, t.runAfter),
    index("outbox_jobs_finished_at_idx").on(t.finishedAt),
    check("outbox_jobs_status_check", oneOf("status", JOB_STATUSES)),
  ],
);
