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
  uuid,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses";
import { createdAt, oneOf, positive, tstz } from "./columns";

// Mirrors PLAN_ACTION_KINDS in @carnet/domain (a unit test keeps them equal).
export const PLAN_ACTION_KIND_VALUES = ["fund", "convert", "defer", "escalate", "payout"] as const;

// Plan revisions are append-only (M3-02): a revision is inserted once and never changed. The app
// role has no UPDATE or DELETE on either table (migration 0004), and the repository has no function
// that does either. `inputs` is the canonical JSON the `inputs_hash` was computed over.
export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    revision: integer("revision").notNull(),
    inputsHash: text("inputs_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    policyVersion: integer("policy_version").notNull(),
    policyHash: text("policy_hash").notNull(),
    heldFundsVisibleInBalances: boolean("held_funds_visible_in_balances").notNull(),
    /** The `now` the plan was computed for. */
    plannedAt: tstz("planned_at").notNull(),
    /** What caused the revision: an outbox event id or a job id. Informational. */
    trigger: text("trigger"),
    inputs: jsonb("inputs").$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("plans_business_id_revision_key").on(t.businessId, t.revision),
    // Target of the tenant-safe composite foreign key from plan_actions.
    unique("plans_id_business_id_key").on(t.id, t.businessId),
    check("plans_revision_check", positive("revision")),
  ],
);

export const planActions = pgTable(
  "plan_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id").notNull(),
    businessId: uuid("business_id").notNull(),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    reasonCode: text("reason_code").notNull(),
    params: jsonb("params").$type<unknown>().notNull(),
    reasonFacts: jsonb("reason_facts").$type<unknown>().notNull(),
    needsApproval: boolean("needs_approval").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("plan_actions_plan_id_seq_key").on(t.planId, t.seq),
    // Target of the tenant-safe composite foreign keys from auto_approvals, plan_action_states and
    // fx_quote_uses (M3-03).
    unique("plan_actions_id_business_id_key").on(t.id, t.businessId),
    index("plan_actions_business_id_idx").on(t.businessId),
    foreignKey({
      name: "plan_actions_plan_same_business_fk",
      columns: [t.planId, t.businessId],
      foreignColumns: [plans.id, plans.businessId],
    }),
    check("plan_actions_kind_check", oneOf("kind", PLAN_ACTION_KIND_VALUES)),
    check("plan_actions_seq_check", positive("seq")),
  ],
);
