import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses";
import { createdAt, oneOf, tstz } from "./columns";
import { payments } from "./payments";

// Mirrors RFI_STATES, RFI_ORPHAN_REASONS and AIRWALLEX_RFI_STATUSES in @carnet/domain (a unit test
// keeps them equal). The schema does not import the domain so drizzle-kit can load it on its own.
export const RFI_STATE_VALUES = [
  "ACTION_REQUIRED",
  "DRAFTING",
  "DRAFT_READY",
  "NEEDS_OWNER",
  "APPROVED",
  "ANSWER_SUBMITTING",
  "ANSWERED",
  "REOPENED",
  "CLOSED",
  "EXPIRED",
] as const;
export const RFI_ORPHAN_REASON_VALUES = [
  "NO_SOURCES",
  "NON_TRANSFER_SOURCE",
  "UNKNOWN_TRANSFER",
  "MULTIPLE_PAYMENTS",
  "OWNER_UNLINKED",
] as const;
export const AIRWALLEX_RFI_STATUS_VALUES = ["ACTION_REQUIRED", "ANSWERED", "CLOSED"] as const;
export const RFI_LINKED_BY_VALUES = ["match", "owner"] as const;

// M2-04, architecture §5. `state` is Carnet's state machine; `airwallex_status`, `airwallex_updated_at`
// and `airwallex_answered_requests` are the newest fetched snapshot's version (stale events are dropped
// against it). An RFI never changes a payment's money status (ADR 0006): this table only links one.
// A linked RFI has `payment_id`; an orphan has `orphan_reason` instead (exactly one of the two).
export const rfis = pgTable(
  "rfis",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    airwallexRfiId: text("airwallex_rfi_id").notNull(),
    type: text("type").notNull(),
    subType: text("sub_type"),
    airwallexStatus: text("airwallex_status").notNull(),
    airwallexUpdatedAt: tstz("airwallex_updated_at").notNull(),
    airwallexAnsweredRequests: integer("airwallex_answered_requests").notNull().default(0),
    state: text("state").notNull(),
    round: integer("round").notNull().default(1),
    expiresAt: tstz("expires_at"),
    expiringSoon: boolean("expiring_soon").notNull().default(false),
    paymentId: uuid("payment_id").references(() => payments.id),
    orphanReason: text("orphan_reason"),
    linkedBy: text("linked_by"),
    // ADR 0018 amendment 1: sorted `TYPE:id` sources; null when the RFI has none (not guarded).
    sourceKey: text("source_key"),
    conflict: boolean("conflict").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Target of the same-business foreign keys from drafts (M2-05).
    unique("rfis_id_business_id_key").on(t.id, t.businessId),
    uniqueIndex("rfis_business_id_airwallex_rfi_id_key").on(t.businessId, t.airwallexRfiId),
    index("rfis_airwallex_rfi_id_idx").on(t.airwallexRfiId),
    index("rfis_business_id_state_idx").on(t.businessId, t.state),
    index("rfis_payment_id_idx").on(t.paymentId),
    // The per-source guard's backstop: one open, non-conflict RFI per business, type and source key.
    uniqueIndex("rfis_one_open_per_source_key")
      .on(t.businessId, t.type, t.sourceKey)
      .where(
        sql`"conflict" = false AND "source_key" IS NOT NULL AND "state" NOT IN ('CLOSED', 'EXPIRED')`,
      ),
    check("rfis_state_check", oneOf("state", RFI_STATE_VALUES)),
    check("rfis_airwallex_status_check", oneOf("airwallex_status", AIRWALLEX_RFI_STATUS_VALUES)),
    check("rfis_orphan_reason_check", oneOf("orphan_reason", RFI_ORPHAN_REASON_VALUES)),
    check("rfis_linked_by_check", oneOf("linked_by", RFI_LINKED_BY_VALUES)),
    check("rfis_round_check", sql.raw(`"round" >= 1`)),
    check(
      "rfis_link_xor_orphan_check",
      sql.raw(`("payment_id" IS NULL) = ("orphan_reason" IS NOT NULL)`),
    ),
  ],
);

// One row per (RFI, round, Airwallex question id). Rows are insert-only: a follow-up adds a new round
// and earlier rounds never change. `needs_drafting` marks the questions M2-05 drafts for that round.
export const rfiQuestions = pgTable(
  "rfi_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    rfiId: uuid("rfi_id")
      .notNull()
      .references(() => rfis.id),
    round: integer("round").notNull(),
    airwallexQuestionId: text("airwallex_question_id").notNull(),
    /** Order of the question within its round, as Airwallex lists it. */
    position: integer("position").notNull(),
    title: jsonb("title").$type<{ en: string | null; zh: string | null }>().notNull(),
    description: jsonb("description").$type<{ en: string | null; zh: string | null }>().notNull(),
    comment: text("comment"),
    answerType: text("answer_type").notNull(),
    sources: jsonb("sources").$type<{ id: string; type: string }[]>().notNull(),
    /** Asked again in this round after being answered in an earlier one (follow-up). */
    reopened: boolean("reopened").notNull().default(false),
    needsDrafting: boolean("needs_drafting").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("rfi_questions_id_business_id_key").on(t.id, t.businessId),
    uniqueIndex("rfi_questions_rfi_round_question_key").on(t.rfiId, t.round, t.airwallexQuestionId),
    index("rfi_questions_business_id_rfi_id_idx").on(t.businessId, t.rfiId),
    check("rfi_questions_round_check", sql.raw(`"round" >= 1`)),
  ],
);
