import { boolean, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tstz } from "./columns";

// Provider-level inbox (no business_id): an event is attributed to a tenant only after the worker
// fetches the resource it names. `provider_event_id` de-duplicates at-least-once delivery.
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerEventId: text("provider_event_id").notNull(),
    name: text("name").notNull(),
    receivedAt: tstz("received_at").notNull().defaultNow(),
    rawBody: text("raw_body").notNull(),
    signatureOk: boolean("signature_ok").notNull(),
    processedAt: tstz("processed_at"),
  },
  (t) => [uniqueIndex("webhook_events_provider_event_id_key").on(t.providerEventId)],
);
