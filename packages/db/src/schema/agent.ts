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
import { createdAt, oneOf, tstz } from "./columns";

// Model calls (architecture §5 and §10, M2-00). A run groups the calls made for one subject (`kind`
// plus `ref`, e.g. a draft for one RFI); a step is one network call to the model. Replays write no
// step. Cost is integer nano-USD: one call costs a fraction of a cent, so minor units would round it
// away. The spend caps in system_flags stay in minor units and are converted by the harness.
export const AGENT_RUN_STATUSES = ["RUNNING", "DONE", "FAILED"] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

// Mirrors the network outcomes of @carnet/agent's CallOutcome (the ones that write a step).
// `killed` and `spend_cap` (M4-02) are refusals before the network: zero tokens, zero cost.
export const AGENT_STEP_OUTCOMES = [
  "ok",
  "refused",
  "truncated",
  "provider_error",
  "killed",
  "spend_cap",
] as const;
export type AgentStepOutcome = (typeof AGENT_STEP_OUTCOMES)[number];

const nanoUsd = (name: string) => bigint(name, { mode: "number" });

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    kind: text("kind").notNull(),
    ref: text("ref").notNull(),
    status: text("status").$type<AgentRunStatus>().notNull().default("RUNNING"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costNanoUsd: nanoUsd("cost_nano_usd").notNull().default(0),
    startedAt: tstz("started_at").notNull().defaultNow(),
    finishedAt: tstz("finished_at"),
    /** The web session that queued the run (M4-05, SESSION_MODEL_CAP_USD); null for webhook work. */
    sessionId: uuid("session_id"),
  },
  (t) => [
    index("agent_runs_kind_ref_idx").on(t.kind, t.ref),
    // Target of the steps' composite key (a step and its run belong to the same business).
    unique("agent_runs_id_business_id_key").on(t.id, t.businessId),
    check("agent_runs_status_check", oneOf("status", AGENT_RUN_STATUSES)),
    check("agent_runs_cost_check", sql.raw(`"cost_nano_usd" >= 0`)),
  ],
);

export const agentSteps = pgTable(
  "agent_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id").notNull(),
    runId: uuid("run_id").notNull(),
    step: text("step").notNull(),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    inputHash: text("input_hash").notNull(),
    outcome: text("outcome").$type<AgentStepOutcome>().notNull(),
    output: jsonb("output").$type<unknown>(),
    stopReason: text("stop_reason"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costNanoUsd: nanoUsd("cost_nano_usd").notNull().default(0),
    latencyMs: integer("latency_ms").notNull(),
    providerRequestId: text("provider_request_id"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "agent_steps_run_same_business_fk",
      columns: [t.runId, t.businessId],
      foreignColumns: [agentRuns.id, agentRuns.businessId],
    }),
    index("agent_steps_run_id_step_idx").on(t.runId, t.step),
    index("agent_steps_input_hash_idx").on(t.inputHash),
    index("agent_steps_created_at_idx").on(t.createdAt),
    check("agent_steps_outcome_check", oneOf("outcome", AGENT_STEP_OUTCOMES)),
    check("agent_steps_cost_check", sql.raw(`"cost_nano_usd" >= 0`)),
  ],
);
