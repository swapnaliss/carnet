import { sql } from "drizzle-orm";
import {
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
import { rfiQuestions, rfis } from "./rfis";
import { users } from "./users";

// Mirror DRAFT_ORIGINS, DRAFT_STATES and ANSWER_STATUSES in @carnet/domain (a test keeps them equal).
export const DRAFT_ORIGIN_VALUES = ["model", "owner", "system"] as const;
export const DRAFT_STATE_VALUES = ["DRAFT_READY", "NEEDS_OWNER"] as const;
export const DRAFT_ANSWER_STATUS_VALUES = ["VERIFIED", "NEEDS_OWNER", "OWNER_AUTHORED"] as const;

// M2-05, architecture §5, ADR 0010. A draft is one version of the answers to an RFI round. It is never
// updated: an owner edit or a re-draft inserts a NEW draft (`parent_draft_id` points at the one it
// replaces) and the earlier one stays. The app role has INSERT and SELECT only, and a trigger refuses
// UPDATE and DELETE for every role (migration 0011). `state` is the roll-up of its answers (one
// NEEDS_OWNER answer makes the draft NEEDS_OWNER) and `blocking` lists those questions with reasons.
// `origin`: model (the drafting call), owner (an edit by a user) or system (the timeout sweeper).
export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    rfiId: uuid("rfi_id").notNull(),
    round: integer("round").notNull(),
    parentDraftId: uuid("parent_draft_id"),
    origin: text("origin").notNull(),
    /** Idempotency: the job id for a model draft, a client key for an owner edit, a sweep key. */
    draftKey: text("draft_key").notNull(),
    promptVersion: text("prompt_version"),
    model: text("model"),
    inputHash: text("input_hash"),
    injectionFlags: jsonb("injection_flags").$type<unknown[]>().notNull().default([]),
    agentRunId: uuid("agent_run_id"),
    state: text("state").notNull(),
    /** `{question_id, reason, explanation}` per NEEDS_OWNER answer. */
    blocking: jsonb("blocking").$type<unknown[]>().notNull().default([]),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("drafts_id_business_id_key").on(t.id, t.businessId),
    foreignKey({
      name: "drafts_rfi_same_business_fk",
      columns: [t.rfiId, t.businessId],
      foreignColumns: [rfis.id, rfis.businessId],
    }),
    foreignKey({
      name: "drafts_parent_same_business_fk",
      columns: [t.parentDraftId, t.businessId],
      foreignColumns: [t.id, t.businessId],
    }),
    uniqueIndex("drafts_rfi_round_key_key").on(t.businessId, t.rfiId, t.round, t.draftKey),
    index("drafts_rfi_id_round_idx").on(t.businessId, t.rfiId, t.round),
    check("drafts_round_check", sql.raw(`"round" >= 1`)),
    check("drafts_origin_check", oneOf("origin", DRAFT_ORIGIN_VALUES)),
    check("drafts_state_check", oneOf("state", DRAFT_STATE_VALUES)),
    check("drafts_owner_check", sql.raw(`("origin" = 'owner') = ("created_by" IS NOT NULL)`)),
    check(
      "drafts_json_check",
      sql.raw(`jsonb_typeof("injection_flags") = 'array' AND jsonb_typeof("blocking") = 'array'`),
    ),
  ],
);

// One answer per question of a draft. `text` and `citations` are written once and never change (the
// app role cannot UPDATE; a trigger refuses it for every role). `verifier_result` is the verdict of the
// pure verifier (@carnet/domain `verifyAnswer`) at the time of insert.
export const draftAnswers = pgTable(
  "draft_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    draftId: uuid("draft_id").notNull(),
    questionId: uuid("question_id").notNull(),
    text: text("text").notNull(),
    /** `{fact_version_id, quote}` per citation. */
    citations: jsonb("citations").$type<unknown[]>().notNull(),
    /** Documents selected for an ATTACHMENT question. */
    documentIds: jsonb("document_ids").$type<string[]>().notNull(),
    status: text("status").notNull(),
    reasonCode: text("reason_code"),
    verifierResult: jsonb("verifier_result").$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "draft_answers_draft_same_business_fk",
      columns: [t.draftId, t.businessId],
      foreignColumns: [drafts.id, drafts.businessId],
    }),
    foreignKey({
      name: "draft_answers_question_same_business_fk",
      columns: [t.questionId, t.businessId],
      foreignColumns: [rfiQuestions.id, rfiQuestions.businessId],
    }),
    unique("draft_answers_draft_question_key").on(t.draftId, t.questionId),
    index("draft_answers_draft_id_idx").on(t.businessId, t.draftId),
    check("draft_answers_status_check", oneOf("status", DRAFT_ANSWER_STATUS_VALUES)),
    check(
      "draft_answers_reason_check",
      sql.raw(`("status" = 'NEEDS_OWNER') = ("reason_code" IS NOT NULL)`),
    ),
    check(
      "draft_answers_json_check",
      sql.raw(`jsonb_typeof("citations") = 'array' AND jsonb_typeof("document_ids") = 'array'`),
    ),
  ],
);

export type DraftRow = typeof drafts.$inferSelect;
export type DraftAnswerRow = typeof draftAnswers.$inferSelect;
