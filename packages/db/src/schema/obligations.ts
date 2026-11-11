import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses";
import { createdAt, currency, isoCurrency, minor, oneOf, positive, tstz } from "./columns";
import { counterparties } from "./counterparties";
import { documents } from "./documents";
import { payments } from "./payments";
import { users } from "./users";

// Mirror CRITICALITY_PROPOSAL_STATUSES in @carnet/domain (a test keeps them equal).
export const CRITICALITY_PROPOSAL_STATUS_VALUES = [
  "PROPOSED",
  "CONFIRMED",
  "OVERRIDDEN",
  "REJECTED",
] as const;
export const CRITICALITY_VERIFIER_RESULT_VALUES = ["VERIFIED", "REJECTED"] as const;

// M3-01 (ADR 0011): what the business owes and when. `criticality` (1 = pay on time, 3 = can slip) is
// null until an owner confirms it, and only the confirm endpoint writes it (repos/obligation-confirm.ts).
// A model's reading of a contract is a row in `criticality_proposals`, never a value here.
export const obligations = pgTable(
  "obligations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    counterpartyId: uuid("counterparty_id").notNull(),
    amountMinor: minor("amount_minor").notNull(),
    currency: currency().notNull(),
    dueAt: tstz("due_at").notNull(),
    criticality: smallint("criticality"),
    criticalityConfirmedBy: uuid("criticality_confirmed_by").references(() => users.id),
    criticalityConfirmedAt: tstz("criticality_confirmed_at"),
    /** The proposal the owner had on screen when confirming (null: none, or set by hand). */
    criticalityConfirmedProposalId: uuid("criticality_confirmed_proposal_id"),
    paymentId: uuid("payment_id").references(() => payments.id),
    sourceDocumentId: uuid("source_document_id"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "obligations_counterparty_same_business_fk",
      columns: [t.counterpartyId, t.businessId],
      foreignColumns: [counterparties.id, counterparties.businessId],
    }),
    foreignKey({
      name: "obligations_source_document_same_business_fk",
      columns: [t.sourceDocumentId, t.businessId],
      foreignColumns: [documents.id, documents.businessId],
    }),
    unique("obligations_id_business_id_key").on(t.id, t.businessId),
    index("obligations_business_id_due_at_idx").on(t.businessId, t.dueAt),
    check("obligations_amount_check", positive("amount_minor")),
    check("obligations_currency_check", isoCurrency("currency")),
    check("obligations_criticality_range_check", sql`${t.criticality} IN (1, 2, 3)`),
    // A criticality exists only because a person confirmed it.
    check(
      "obligations_criticality_confirmed_check",
      sql`${t.criticality} IS NULL OR ${t.criticalityConfirmedBy} IS NOT NULL`,
    ),
    check(
      "obligations_confirmed_pair_check",
      sql`(${t.criticalityConfirmedBy} IS NULL) = (${t.criticalityConfirmedAt} IS NULL)`,
    ),
  ],
);

export type ObligationRow = typeof obligations.$inferSelect;

// M3-01: the model's proposal for one obligation, read from a contract. `verifier_result` is decided in
// code (quote found verbatim on the cited page, and it concerns payment timing or late-payment
// consequences); a REJECTED proposal carries the reason and no weight. Only `status` changes after the
// insert: the confirm endpoint moves PROPOSED to CONFIRMED or OVERRIDDEN.
export const criticalityProposals = pgTable(
  "criticality_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    obligationId: uuid("obligation_id").notNull(),
    /** Idempotency of the `obligation.criticality.propose` job (its job id). */
    proposalKey: text("proposal_key").notNull(),
    proposedCriticality: smallint("proposed_criticality"),
    rationale: text("rationale").notNull().default(""),
    quote: text("quote").notNull().default(""),
    quotePage: integer("quote_page"),
    documentId: uuid("document_id").notNull(),
    agentRunId: uuid("agent_run_id"),
    verifierResult: text("verifier_result").notNull(),
    /** Why the verifier rejected it (`quote_not_found`, `no_payment_clause`, `no_text_layer`, ...). */
    verifierReason: text("verifier_reason"),
    status: text("status").notNull(),
    injectionSuspected: boolean("injection_suspected").notNull().default(false),
    injectionFlags: jsonb("injection_flags").$type<unknown[]>().notNull().default([]),
    promptVersion: text("prompt_version"),
    model: text("model"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "criticality_proposals_obligation_same_business_fk",
      columns: [t.obligationId, t.businessId],
      foreignColumns: [obligations.id, obligations.businessId],
    }),
    foreignKey({
      name: "criticality_proposals_document_same_business_fk",
      columns: [t.documentId, t.businessId],
      foreignColumns: [documents.id, documents.businessId],
    }),
    unique("criticality_proposals_id_business_id_key").on(t.id, t.businessId),
    uniqueIndex("criticality_proposals_key_key").on(t.businessId, t.obligationId, t.proposalKey),
    index("criticality_proposals_obligation_idx").on(t.businessId, t.obligationId, t.createdAt),
    check("criticality_proposals_range_check", sql`${t.proposedCriticality} IN (1, 2, 3)`),
    check(
      "criticality_proposals_status_check",
      oneOf("status", CRITICALITY_PROPOSAL_STATUS_VALUES),
    ),
    check(
      "criticality_proposals_verifier_check",
      oneOf("verifier_result", CRITICALITY_VERIFIER_RESULT_VALUES),
    ),
    // A rejected proposal is REJECTED and says why; a verified one carries a value and a quote.
    check(
      "criticality_proposals_rejected_check",
      sql`(${t.verifierResult} = 'REJECTED') = (${t.status} = 'REJECTED')`,
    ),
    check(
      "criticality_proposals_verified_check",
      sql`${t.verifierResult} = 'REJECTED' OR (${t.proposedCriticality} IS NOT NULL AND ${t.quotePage} IS NOT NULL AND length(${t.quote}) > 0)`,
    ),
    check(
      "criticality_proposals_reason_check",
      sql`(${t.verifierResult} = 'REJECTED') = (${t.verifierReason} IS NOT NULL)`,
    ),
  ],
);

export type CriticalityProposalRow = typeof criticalityProposals.$inferSelect;
