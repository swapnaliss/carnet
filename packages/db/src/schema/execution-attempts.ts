import { check, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { businesses } from "./businesses";
import { createdAt, oneOf, tstz } from "./columns";

export const ATTEMPT_KINDS = ["transfer", "conversion", "respond"] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];
export const ATTEMPT_STATUSES = [
  "INTENT",
  "SENT_TO_AIRWALLEX",
  "CONFIRMED",
  "UNKNOWN",
  "REJECTED",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

// ADR 0007: written before any outbound money call; `request_id` is minted once per intent and only
// reused to retry the same operation, so it is unique across the table.
export const executionAttempts = pgTable(
  "execution_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    kind: text("kind").$type<AttemptKind>().notNull(),
    refId: uuid("ref_id").notNull(),
    requestId: uuid("request_id").notNull(),
    status: text("status").$type<AttemptStatus>().notNull().default("INTENT"),
    response: jsonb("response").$type<unknown>(),
    createdAt: createdAt(),
    resolvedAt: tstz("resolved_at"),
  },
  (t) => [
    uniqueIndex("execution_attempts_request_id_key").on(t.requestId),
    index("execution_attempts_business_id_status_idx").on(t.businessId, t.status),
    check("execution_attempts_kind_check", oneOf("kind", ATTEMPT_KINDS)),
    check("execution_attempts_status_check", oneOf("status", ATTEMPT_STATUSES)),
  ],
);
