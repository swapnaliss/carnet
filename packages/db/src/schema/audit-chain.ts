import { sql } from "drizzle-orm";
import { bigint, boolean, check, integer, pgTable, smallint, text } from "drizzle-orm/pg-core";
import { tstz } from "./columns";

// M4-01 (ADR 0013). `audit_chain_head` is the single row appendAudit locks (FOR UPDATE) so concurrent
// appends cannot fork the chain; it also records the tail, which exposes a deleted last row.
// `audit_chain_status` holds the last verification result the worker stored for /ops.
export const auditChainHead = pgTable(
  "audit_chain_head",
  {
    id: smallint("id").primaryKey().default(1),
    lastId: bigint("last_id", { mode: "bigint" }),
    lastHash: text("last_hash"),
    rowCount: bigint("row_count", { mode: "bigint" }).notNull().default(sql`0`),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [check("audit_chain_head_singleton_check", sql`${t.id} = 1`)],
);

export const auditChainStatus = pgTable(
  "audit_chain_status",
  {
    id: smallint("id").primaryKey().default(1),
    ok: boolean("ok").notNull(),
    checked: integer("checked").notNull(),
    firstBadId: bigint("first_bad_id", { mode: "bigint" }),
    reason: text("reason"),
    headHash: text("head_hash"),
    verifiedAt: tstz("verified_at").notNull().defaultNow(),
  },
  (t) => [check("audit_chain_status_singleton_check", sql`${t.id} = 1`)],
);
