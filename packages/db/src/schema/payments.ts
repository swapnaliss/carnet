import { check, foreignKey, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { businesses } from "./businesses";
import { createdAt, currency, isoCurrency, minor, oneOf, positive, tstz } from "./columns";
import { counterparties } from "./counterparties";

// Mirrors TRANSFER_STATUSES in @carnet/domain (a unit test keeps them equal). The schema does not
// import the domain so drizzle-kit can load it on its own.
export const TRANSFER_STATUS_VALUES = [
  "IN_APPROVAL",
  "APPROVAL_RECALLED",
  "APPROVAL_REJECTED",
  "APPROVAL_BLOCKED",
  "SCHEDULED",
  "OVERDUE",
  "PROCESSING",
  "SENT",
  "PAID",
  "FAILED",
  "CANCELLED",
] as const;

// A payment's view is a projection of (transfer_status, open RFI); it is never stored (ADR 0006).
// transfer_status and transfer_updated_at are written together.
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    counterpartyId: uuid("counterparty_id"),
    obligationId: uuid("obligation_id"),
    amountMinor: minor("amount_minor").notNull(),
    currency: currency().notNull(),
    sourceCurrency: currency("source_currency").notNull(),
    method: text("method").notNull(),
    reference: text("reference").notNull(),
    transferId: text("transfer_id"),
    transferStatus: text("transfer_status"),
    transferUpdatedAt: tstz("transfer_updated_at"),
    failureType: text("failure_type"),
    createdAt: createdAt(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("payments_business_id_transfer_status_idx").on(t.businessId, t.transferStatus),
    uniqueIndex("payments_transfer_id_key").on(t.transferId),
    // Composite key: the counterparty must belong to the same business (no cross-tenant reference).
    foreignKey({
      name: "payments_counterparty_same_business_fk",
      columns: [t.counterpartyId, t.businessId],
      foreignColumns: [counterparties.id, counterparties.businessId],
    }),
    check("payments_amount_minor_check", positive("amount_minor")),
    check("payments_currency_check", isoCurrency("currency")),
    check("payments_source_currency_check", isoCurrency("source_currency")),
    check("payments_transfer_status_check", oneOf("transfer_status", TRANSFER_STATUS_VALUES)),
  ],
);
