import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses";
import { createdAt, oneOf } from "./columns";
import { documentFacts } from "./document-facts";
import { documents } from "./documents";
import { payments } from "./payments";
import { users } from "./users";

// Mirror EVIDENCE_FLAGS and EVIDENCE_CHECK_CAUSES in @carnet/domain (a test keeps them equal).
export const EVIDENCE_FLAG_VALUES = ["strong", "weak", "missing"] as const;
export const EVIDENCE_CHECK_CAUSE_VALUES = [
  "link_added",
  "link_removed",
  "facts_confirmed",
  "send",
] as const;

// M2-03: a document the owner attached to a payment as evidence. `fact_version_id` is the latest
// stored fact version of the document when it was attached (null while extraction has not finished);
// the check itself always reads the latest usable facts and records the versions it used in
// `evidence_checks`. The document must belong to the same business (composite key).
export const evidenceLinks = pgTable(
  "evidence_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    documentId: uuid("document_id").notNull(),
    factVersionId: uuid("fact_version_id").references(() => documentFacts.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "evidence_links_document_same_business_fk",
      columns: [t.documentId, t.businessId],
      foreignColumns: [documents.id, documents.businessId],
    }),
    uniqueIndex("evidence_links_payment_document_key").on(t.paymentId, t.documentId),
    unique("evidence_links_id_business_id_key").on(t.id, t.businessId),
    index("evidence_links_business_id_payment_id_idx").on(t.businessId, t.paymentId),
  ],
);

// M2-03: the snapshot of a payment's evidence check, written on every change to its links and when the
// payment is sent. Insert-only (the app role has no UPDATE or DELETE; migration 0011). `rules` holds the
// rule results, `reasons` the ordered reasons shown, `fact_version_ids` the fact versions the rules read.
export const evidenceChecks = pgTable(
  "evidence_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    flag: text("flag").notNull(),
    rules: jsonb("rules").$type<unknown[]>().notNull(),
    reasons: jsonb("reasons").$type<unknown[]>().notNull(),
    factVersionIds: jsonb("fact_version_ids").$type<string[]>().notNull(),
    checkHash: text("check_hash").notNull(),
    cause: text("cause").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("evidence_checks_business_id_payment_id_idx").on(t.businessId, t.paymentId, t.createdAt),
    check("evidence_checks_flag_check", oneOf("flag", EVIDENCE_FLAG_VALUES)),
    check("evidence_checks_cause_check", oneOf("cause", EVIDENCE_CHECK_CAUSE_VALUES)),
    check("evidence_checks_hash_check", sql.raw(`"check_hash" ~ '^[0-9a-f]{64}$'`)),
  ],
);
