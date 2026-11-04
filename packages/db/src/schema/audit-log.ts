import { bigint, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { businesses } from "./businesses";
import { tstz } from "./columns";

// ADR 0013: append-only. The app role holds INSERT and SELECT only (migrations/0001_grants.sql).
// `prev_hash` and `hash` are filled by the hash chain in M4-01; they are nullable until then.
// `business_id` is null for system events (for example the kill switch).
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    businessId: uuid("business_id").references(() => businesses.id),
    prevHash: text("prev_hash"),
    hash: text("hash"),
    at: tstz("at").notNull().defaultNow(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    subject: text("subject").notNull(),
    data: jsonb("data").$type<unknown>().notNull().default({}),
  },
  (t) => [index("audit_log_business_id_id_idx").on(t.businessId, t.id)],
);
