import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { businesses } from "./businesses";
import { createdAt, oneOf, tstz } from "./columns";
import { users } from "./users";

// Mirror APPROVAL_KINDS, APPROVAL_STATUSES and APPROVAL_END_REASONS in @carnet/domain (a unit test
// keeps them equal). The schema does not import the domain so drizzle-kit can load it on its own.
export const APPROVAL_KIND_VALUES = ["rfi_answer"] as const;
export const APPROVAL_STATUS_VALUES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "CONSUMED",
] as const;
export const APPROVAL_END_REASON_VALUES = [
  "REJECTED_BY_USER",
  "SUPERSEDED",
  "TTL",
  "KILL_SWITCH",
  "RFI_CHANGED",
] as const;

// ADR 0008, M2-07: an approval is bound to the exact content the approver saw. `hash` is SHA-256 over
// the canonical JSON of `shown_snapshot` (the subject), `nonce` is server generated, and consumption is
// one atomic UPDATE ... WHERE status='APPROVED' AND hash=? AND expires_at > now(). The binding columns
// never change after insert (a trigger in migration 0009 refuses it for every role); only the status
// columns move. At most one live (PENDING or APPROVED) approval exists per subject.
export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    kind: text("kind").notNull(),
    /** The RFI id (rfi_answer); a payment or conversion id for the M3-03 kinds. */
    subjectRef: text("subject_ref").notNull(),
    hash: text("hash").notNull(),
    nonce: text("nonce").notNull(),
    approverId: uuid("approver_id")
      .notNull()
      .references(() => users.id),
    status: text("status").notNull().default("PENDING"),
    endReason: text("end_reason"),
    expiresAt: tstz("expires_at").notNull(),
    consumedAt: tstz("consumed_at"),
    /** Exactly what the approver saw: the hashed subject plus display fields. */
    shownSnapshot: jsonb("shown_snapshot").$type<unknown>().notNull(),
    createdAt: createdAt(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("approvals_business_id_subject_ref_idx").on(t.businessId, t.kind, t.subjectRef),
    index("approvals_status_expires_at_idx").on(t.status, t.expiresAt),
    uniqueIndex("approvals_nonce_key").on(t.nonce),
    uniqueIndex("approvals_one_live_per_subject")
      .on(t.businessId, t.kind, t.subjectRef)
      .where(sql`"status" IN ('PENDING', 'APPROVED')`),
    check("approvals_kind_check", oneOf("kind", APPROVAL_KIND_VALUES)),
    check("approvals_status_check", oneOf("status", APPROVAL_STATUS_VALUES)),
    check("approvals_end_reason_check", oneOf("end_reason", APPROVAL_END_REASON_VALUES)),
    check("approvals_hash_check", sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
    check("approvals_consumed_check", sql`("status" = 'CONSUMED') = ("consumed_at" IS NOT NULL)`),
  ],
);
