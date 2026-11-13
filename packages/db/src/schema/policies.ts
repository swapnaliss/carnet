import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses";
import { createdAt, currency, isoCurrency, minor, oneOf, positive, tstz } from "./columns";
import { planActions } from "./plans";

// Mirrors PLAN_ACTION_STATES in the executors (a unit test keeps them equal).
export const ACTION_STATE_VALUES = [
  "PROPOSED",
  "APPROVED",
  "AUTO_APPROVED",
  "EXECUTING",
  "DONE",
  "FAILED",
  "SUPERSEDED",
] as const;
export type ActionState = (typeof ACTION_STATE_VALUES)[number];

// M3-03, ADR 0011. A policy version is append-only (migration 0016 revokes UPDATE and DELETE): a change
// is a new version with its own hash. `content` is the canonical policy the hash was computed over.
export const policies = pgTable(
  "policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    version: integer("version").notNull(),
    hash: text("hash").notNull(),
    content: jsonb("content").$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("policies_business_id_version_key").on(t.businessId, t.version),
    // Target of the composite foreign key from auto_approvals: a version and its hash travel together.
    unique("policies_business_id_version_hash_key").on(t.businessId, t.version, t.hash),
    check("policies_version_check", positive("version")),
    check("policies_hash_check", sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
  ],
);

// One row per automatically approved conversion: which policy version and hash allowed it, and the
// day's running total after it. Append-only. `action_id` is unique: an action is auto-approved once.
export const autoApprovals = pgTable(
  "auto_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    actionId: uuid("action_id").notNull(),
    policyVersion: integer("policy_version").notNull(),
    policyHash: text("policy_hash").notNull(),
    /** The sell amount, minor units of `currency`. */
    amountMinor: minor("amount_minor").notNull(),
    currency: currency().notNull(),
    dailyTotalAfterMinor: bigint("daily_total_after_minor", { mode: "bigint" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("auto_approvals_action_id_key").on(t.actionId),
    index("auto_approvals_business_id_currency_created_at_idx").on(
      t.businessId,
      t.currency,
      t.createdAt,
    ),
    foreignKey({
      name: "auto_approvals_action_same_business_fk",
      columns: [t.actionId, t.businessId],
      foreignColumns: [planActions.id, planActions.businessId],
    }),
    foreignKey({
      name: "auto_approvals_policy_fk",
      columns: [t.businessId, t.policyVersion, t.policyHash],
      foreignColumns: [policies.businessId, policies.version, policies.hash],
    }),
    check("auto_approvals_amount_check", positive("amount_minor")),
    check("auto_approvals_currency_check", isoCurrency("currency")),
  ],
);

// Where a stored plan action is in its life. `plan_actions` rows never change, so the state lives
// here; no row means PROPOSED. Moves only through compare-and-set updates in the executors.
export const planActionStates = pgTable(
  "plan_action_states",
  {
    actionId: uuid("action_id").primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    status: text("status").notNull().default("PROPOSED"),
    /** Why it is not moving: a policy denial code, KILL_SWITCH, SUPERSEDED, a refusal code. */
    reason: text("reason"),
    attemptId: uuid("attempt_id"),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("plan_action_states_business_id_status_idx").on(t.businessId, t.status),
    foreignKey({
      name: "plan_action_states_action_same_business_fk",
      columns: [t.actionId, t.businessId],
      foreignColumns: [planActions.id, planActions.businessId],
    }),
    check("plan_action_states_status_check", oneOf("status", ACTION_STATE_VALUES)),
  ],
);

// Carnet's own single-use rule for FX quotes (the sandbox returns MULTI_USE and accepted a reused
// quote, M0-03): one conversion per quote id, enforced by the primary key.
export const fxQuoteUses = pgTable(
  "fx_quote_uses",
  {
    quoteId: text("quote_id").primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    actionId: uuid("action_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("fx_quote_uses_business_id_idx").on(t.businessId),
    foreignKey({
      name: "fx_quote_uses_action_same_business_fk",
      columns: [t.actionId, t.businessId],
      foreignColumns: [planActions.id, planActions.businessId],
    }),
  ],
);
