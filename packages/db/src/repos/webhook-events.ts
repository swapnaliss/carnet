// Webhook inbox additions (M1-05). System-level functions take `db`; the one tenant read
// (`listWebhookEventsForPayment`, M1-08) takes `ctx` and only reaches events of that business's
// transfers.
import type { PaymentId } from "@carnet/domain";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../client";
import { translateDbError } from "../errors";
import { outboxJobs, payments, webhookEvents } from "../schema/index";
import type { RepoCtx } from "./context";
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

export interface PaymentWebhookEvent {
  /** Carnet's inbox row id. */
  readonly id: string;
  /** Airwallex's event id (the de-duplication key). */
  readonly providerEventId: string;
  readonly name: string;
  readonly receivedAt: Date;
  readonly ackedAt: Date | null;
  readonly processedAt: Date | null;
  readonly signatureOk: boolean;
  /** The body exactly as delivered (the signature was checked over these bytes). */
  readonly rawBody: string;
}

/**
 * The webhook deliveries that named this payment's transfer (M1-08), oldest first. Tenant-scoped: the
 * transfer id must belong to a payment of `ctx.businessId`, so another business's payment id returns
 * nothing. An event is linked through the `transfer.sync` job the inbox wrote with it (M1-05).
 */
export async function listWebhookEventsForPayment(
  ctx: RepoCtx,
  paymentId: PaymentId,
  limit = 50,
): Promise<PaymentWebhookEvent[]> {
  return ctx.db
    .select({
      id: webhookEvents.id,
      providerEventId: webhookEvents.providerEventId,
      name: webhookEvents.name,
      receivedAt: webhookEvents.receivedAt,
      ackedAt: webhookEvents.ackedAt,
      processedAt: webhookEvents.processedAt,
      signatureOk: webhookEvents.signatureOk,
      rawBody: webhookEvents.rawBody,
    })
    .from(webhookEvents)
    .innerJoin(
      outboxJobs,
      and(
        eq(outboxJobs.kind, "transfer.sync"),
        sql`${outboxJobs.payload} ->> 'webhookEventId' = ${webhookEvents.id}::text`,
      ),
    )
    .innerJoin(
      payments,
      and(
        eq(payments.businessId, ctx.businessId),
        eq(payments.id, paymentId),
        isNotNull(payments.transferId),
        sql`${outboxJobs.payload} ->> 'transferId' = ${payments.transferId}`,
      ),
    )
    .orderBy(asc(webhookEvents.receivedAt), asc(webhookEvents.id))
    .limit(Math.min(Math.max(limit, 1), 200));
}
