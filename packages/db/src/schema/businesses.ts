import { integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt } from "./columns";

// Tenant root. `reserve_floor` (per currency) arrives with the planner by a new migration.
export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  policyVersion: integer("policy_version").notNull().default(1),
  createdAt: createdAt(),
});
