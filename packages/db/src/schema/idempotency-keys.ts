import { integer, jsonb, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { businesses } from "./businesses";
import { createdAt } from "./columns";

// ADR 0004: money and approval endpoints only. Scoped by business so one tenant's key can never
// replay another tenant's response.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    endpoint: text("endpoint").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    response: jsonb("response").$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "idempotency_keys_pkey", columns: [t.businessId, t.endpoint, t.key] }),
  ],
);
