import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
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
import { createdAt, oneOf } from "./columns";
import { documents } from "./documents";
import { users } from "./users";

// Mirror FACT_VERSION_SOURCES and FACT_VERSION_STATUSES in @carnet/domain (a test keeps them equal).
export const FACT_VERSION_SOURCE_VALUES = ["model", "owner"] as const;
export const FACT_VERSION_STATUS_VALUES = ["EXTRACTED", "EXTRACTION_FAILED"] as const;

// ADR 0010 (M2-02): the facts extracted from a document, versioned and immutable. A re-extraction or an
// owner correction inserts version n+1; the app role has no UPDATE or DELETE on this table and a
// trigger refuses both for every role (migration 0010). `facts` holds `{key, value, parsed, quote,
// page, quote_verified, needs_confirmation, issues}` per fact; `quote_verified` is set by code only.
export const documentFacts = pgTable(
  "document_facts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    documentId: uuid("document_id").notNull(),
    version: integer("version").notNull(),
    /** Idempotency of the `document.extract` job (its job id); null for owner versions. */
    extractionKey: text("extraction_key"),
    source: text("source").notNull(),
    status: text("status").notNull(),
    /** Why the extraction failed (`AGENTS_DISABLED`, `CAP_EXCEEDED`, ...); set iff EXTRACTION_FAILED. */
    failure: text("failure"),
    promptVersion: text("prompt_version"),
    model: text("model"),
    textLayer: boolean("text_layer").notNull(),
    facts: jsonb("facts").$type<unknown[]>().notNull(),
    /** `{key, text, page}` per fact that has a quote. */
    quotes: jsonb("quotes").$type<unknown[]>().notNull(),
    /** Every fact's quote is verified against the text layer (false when empty). */
    quotesVerified: boolean("quotes_verified").notNull(),
    ownerConfirmedBy: uuid("owner_confirmed_by").references(() => users.id),
    injectionFlags: jsonb("injection_flags").$type<unknown[]>().notNull().default([]),
    agentRunId: uuid("agent_run_id"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "document_facts_document_same_business_fk",
      columns: [t.documentId, t.businessId],
      foreignColumns: [documents.id, documents.businessId],
    }),
    unique("document_facts_document_version_key").on(t.businessId, t.documentId, t.version),
    uniqueIndex("document_facts_extraction_key_key").on(
      t.businessId,
      t.documentId,
      t.extractionKey,
    ),
    index("document_facts_document_id_idx").on(t.businessId, t.documentId),
    check("document_facts_version_check", sql`${t.version} >= 1`),
    check("document_facts_source_check", oneOf("source", FACT_VERSION_SOURCE_VALUES)),
    check("document_facts_status_check", oneOf("status", FACT_VERSION_STATUS_VALUES)),
    check(
      "document_facts_failure_check",
      sql`(${t.status} = 'EXTRACTION_FAILED') = (${t.failure} IS NOT NULL)`,
    ),
    check(
      "document_facts_owner_check",
      sql`(${t.source} = 'owner') = (${t.ownerConfirmedBy} IS NOT NULL)`,
    ),
    check(
      "document_facts_facts_check",
      sql`jsonb_typeof(${t.facts}) = 'array' AND jsonb_typeof(${t.quotes}) = 'array' AND jsonb_typeof(${t.injectionFlags}) = 'array'`,
    ),
  ],
);

export type DocumentFactsRow = typeof documentFacts.$inferSelect;
