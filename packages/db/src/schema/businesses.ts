import { integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt } from "./columns";

// Tenant root. `reserve_floor` (per currency) arrives with the planner by a new migration.
// `airwallex_account_id` (M2-04) attributes a provider event that names no Carnet object (an orphan
// RFI) to its tenant; null until the business's Airwallex account id is recorded.
export const businesses = pgTable(
  "businesses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    policyVersion: integer("policy_version").notNull().default(1),
    airwallexAccountId: text("airwallex_account_id"),
    // M2-03: `{contract_required_above_minor: {USD: 100000}}`; `{}` means the defaults (domain/evidence).
    evidencePolicy: jsonb("evidence_policy").$type<unknown>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("businesses_airwallex_account_id_key").on(t.airwallexAccountId)],
);
