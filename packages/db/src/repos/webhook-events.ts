// Webhook inbox additions (M1-05). System-level: takes `db`, not a tenant context.
import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { translateDbError } from "../errors";
import { webhookEvents } from "../schema/index";
import type { NewWebhookEvent, WebhookEvent } from "./system";

/**
 * Stores the event unless its provider event id is already stored. Returns the new row, or null for
 * a duplicate delivery. Uses ON CONFLICT DO NOTHING, so a duplicate never aborts the caller's
 * transaction (the route writes the event and its outbox job together, ADR 0005).
 */
export async function insertWebhookEventIfNew(
  db: Db,
  input: NewWebhookEvent,
): Promise<WebhookEvent | null> {
  try {
    const [row] = await db
      .insert(webhookEvents)
      .values(input)
      .onConflictDoNothing({ target: webhookEvents.providerEventId })
      .returning();
    return row ?? null;
  } catch (error) {
    throw translateDbError(error);
  }
}

/**
 * Stamps the acknowledgement time (M1-09). The webhook route calls it as the last statement of the
 * inbox transaction, so `acked_at - received_at` is the time to a committed, acknowledged event.
 */
export async function markWebhookEventAcked(db: Db, id: string, at: Date): Promise<void> {
  await db.update(webhookEvents).set({ ackedAt: at }).where(eq(webhookEvents.id, id));
}
