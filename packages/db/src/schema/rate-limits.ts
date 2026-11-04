import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { tstz } from "./columns";

// Fixed-window counters (ADR 0012); the key names the route and the caller (M1-10).
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: tstz("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ name: "rate_limits_pkey", columns: [t.key, t.windowStart] })],
);
