// Webhook inbox additions (M1-05). System-level: takes `db`, not a tenant context.
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
