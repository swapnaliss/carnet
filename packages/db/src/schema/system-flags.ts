import { sql } from "drizzle-orm";
import { boolean, check, pgTable, smallint } from "drizzle-orm/pg-core";
import { currency, isoCurrency, minor, tstz } from "./columns";

// One row (id = 1), seeded by migration 0001. The kill switch (M1-05, M4-02) reads it.
// Caps are money: minor units plus currency.
export const systemFlags = pgTable(
  "system_flags",
  {
    id: smallint("id").primaryKey().default(1),
    agentsEnabled: boolean("agents_enabled").notNull().default(true),
    executionEnabled: boolean("execution_enabled").notNull().default(true),
    dailySpendCapMinor: minor("daily_spend_cap_minor").notNull(),
    perRunCapMinor: minor("per_run_cap_minor").notNull(),
    capCurrency: currency("cap_currency").notNull().default("USD"),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check("system_flags_singleton_check", sql`${t.id} = 1`),
    check("system_flags_cap_currency_check", isoCurrency("cap_currency")),
  ],
);
