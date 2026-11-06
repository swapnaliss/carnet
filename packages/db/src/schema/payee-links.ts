import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { businesses } from "./businesses";
import { createdAt, oneOf, tstz } from "./columns";
import { payments } from "./payments";
import { users } from "./users";

// Mirrors DISCLOSURE_LEVELS in @carnet/domain (a unit test keeps them equal).
export const DISCLOSURE_LEVEL_VALUES = ["GENERIC", "DELAYED_FOR_VERIFICATION"] as const;

// A read-only link a payee opens to see one status word (M3-06). Only the SHA-256 of the token is
// stored (64 hex characters); the raw token is shown once at creation and never written anywhere.
export const payeeLinks = pgTable(
  "payee_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    disclosureLevel: text("disclosure_level").notNull().default("GENERIC"),
    revokedAt: tstz("revoked_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    lastViewedAt: tstz("last_viewed_at"),
  },
  (t) => [
    uniqueIndex("payee_links_token_hash_key").on(t.tokenHash),
    index("payee_links_business_id_payment_id_idx").on(t.businessId, t.paymentId),
    check("payee_links_token_hash_check", sql.raw(`"token_hash" ~ '^[0-9a-f]{64}$'`)),
    check("payee_links_disclosure_level_check", oneOf("disclosure_level", DISCLOSURE_LEVEL_VALUES)),
  ],
);
