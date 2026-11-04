import { char, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { businesses } from "./businesses";
import { createdAt } from "./columns";

export const counterparties = pgTable(
  "counterparties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    name: text("name").notNull(),
    country: char("country", { length: 2 }).notNull(),
    beneficiaryId: text("beneficiary_id"),
    accountFingerprint: text("account_fingerprint"),
    createdAt: createdAt(),
  },
  (t) => [
    index("counterparties_business_id_idx").on(t.businessId),
    // Target of tenant-safe composite foreign keys: a row can only reference a counterparty of the
    // same business.
    unique("counterparties_id_business_id_key").on(t.id, t.businessId),
  ],
);
