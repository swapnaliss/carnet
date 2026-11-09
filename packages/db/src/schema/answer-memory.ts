import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { approvals } from "./approvals";
import { businesses } from "./businesses";
import { createdAt, tstz } from "./columns";
import { counterparties } from "./counterparties";
import { rfiQuestions } from "./rfis";

// M2-06, architecture §5 and §13. One row per question of an approved answer whose respond attempt is
// CONFIRMED (the `answer.submitted` event). Never written from a draft, a rejected, expired or not yet
// confirmed approval. Rows are immutable (app role INSERT and SELECT only; a trigger refuses UPDATE and
// DELETE for every role, migration 0013): a newer approval adds a row and the lookup returns the latest.
// `fingerprint` is the exact, normalised hash of counterparty + answer type + question text
// (`fingerprint()` in @carnet/domain); `fp_version` is the normalisation it was computed under.
export const answerMemory = pgTable(
  "answer_memory",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    counterpartyId: uuid("counterparty_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    fpVersion: integer("fp_version").notNull(),
    answerType: text("answer_type").notNull(),
    /** The Carnet question the approved answer was for (provenance; not part of the match). */
    questionId: uuid("question_id").notNull(),
    answerText: text("answer_text").notNull(),
    /** `{fact_version_id, quote, document_id, key}` per citation (MemoryCitation in @carnet/domain). */
    citations: jsonb("citations").$type<unknown[]>().notNull(),
    /** `{document_id, sha256}` per attached document, as approved. */
    attachments: jsonb("attachments").$type<unknown[]>().notNull(),
    sourceApprovalId: uuid("source_approval_id")
      .notNull()
      .references(() => approvals.id),
    /** When the source approval was consumed. */
    approvedAt: tstz("approved_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "answer_memory_counterparty_same_business_fk",
      columns: [t.counterpartyId, t.businessId],
      foreignColumns: [counterparties.id, counterparties.businessId],
    }),
    foreignKey({
      name: "answer_memory_question_same_business_fk",
      columns: [t.questionId, t.businessId],
      foreignColumns: [rfiQuestions.id, rfiQuestions.businessId],
    }),
    // The lookup index (architecture §5).
    index("answer_memory_lookup_idx").on(t.businessId, t.counterpartyId, t.fingerprint),
    // One row per approval and question: a redelivered `answer.submitted` writes nothing twice.
    uniqueIndex("answer_memory_approval_question_key").on(t.sourceApprovalId, t.questionId),
    check("answer_memory_fingerprint_check", sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check("answer_memory_fp_version_check", sql.raw(`"fp_version" >= 1`)),
    check(
      "answer_memory_json_check",
      sql.raw(`jsonb_typeof("citations") = 'array' AND jsonb_typeof("attachments") = 'array'`),
    ),
  ],
);

export type AnswerMemoryRow = typeof answerMemory.$inferSelect;
