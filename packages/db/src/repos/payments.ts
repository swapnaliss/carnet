import {
  type BusinessId,
  type CounterpartyId,
  type Currency,
  isTransferStatus,
  type Money,
  newPaymentId,
  type PaymentId,
  type TransferStatus,
} from "@carnet/domain";
import { and, asc, desc, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import { translateDbError } from "../errors";
import { outboxJobs, payments, webhookEvents } from "../schema/index";
import { currencyFromDb, moneyFromDb, type RepoCtx } from "./context";

/**
 * A payment row. Its view (AWAITING_APPROVAL, SENT, held, ...) is never stored: derive it with
 * `project(transferStatus, openRfi)` from @carnet/domain (ADR 0006).
 */
export interface Payment {
  readonly id: PaymentId;
  readonly businessId: BusinessId;
  readonly counterpartyId: CounterpartyId | null;
  readonly obligationId: string | null;
  readonly amount: Money;
  readonly sourceCurrency: Currency;
  readonly method: string;
  readonly reference: string;
  readonly transferId: string | null;
  readonly transferStatus: TransferStatus | null;
  readonly transferUpdatedAt: Date | null;
  readonly failureType: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type Row = typeof payments.$inferSelect;
function toPayment(r: Row): Payment {
  const status = r.transferStatus;
  if (status !== null && !isTransferStatus(status)) {
    throw new Error(`unknown transfer status in database: ${status}`);
  }
  return {
    id: r.id as PaymentId,
    businessId: r.businessId as BusinessId,
    counterpartyId: r.counterpartyId as CounterpartyId | null,
    obligationId: r.obligationId,
    amount: moneyFromDb(r.amountMinor, r.currency),
    sourceCurrency: currencyFromDb(r.sourceCurrency),
    method: r.method,
    reference: r.reference,
    transferId: r.transferId,
    transferStatus: status,
    transferUpdatedAt: r.transferUpdatedAt,
    failureType: r.failureType,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export interface NewPayment {
  id?: PaymentId;
  /** Must belong to the same business (composite foreign key). */
  counterpartyId?: CounterpartyId | null;
  obligationId?: string | null;
  amount: Money;
  sourceCurrency: Currency;
  method: string;
  reference: string;
}

/** Throws ForeignKeyViolationError when the counterparty is not in this business. */
export async function createPayment(ctx: RepoCtx, input: NewPayment): Promise<Payment> {
  try {
    const [row] = await ctx.db
      .insert(payments)
      .values({
        id: input.id ?? newPaymentId(),
        businessId: ctx.businessId,
        counterpartyId: input.counterpartyId ?? null,
        obligationId: input.obligationId ?? null,
        amountMinor: input.amount.minor,
        currency: input.amount.currency,
        sourceCurrency: input.sourceCurrency,
        method: input.method,
        reference: input.reference,
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return toPayment(row);
  } catch (error) {
    throw translateDbError(error);
  }
}

export async function getPayment(ctx: RepoCtx, id: PaymentId): Promise<Payment | null> {
  const [row] = await ctx.db
    .select()
    .from(payments)
    .where(and(eq(payments.businessId, ctx.businessId), eq(payments.id, id)));
  return row ? toPayment(row) : null;
}

/**
 * Reads the payment and locks its row until the transaction ends (`ctx.db` must be a transaction).
 * Serialises concurrent transfer updates so `applyTransferUpdate` always compares against the latest
 * stored state (M1-05).
 */
export async function getPaymentForUpdate(ctx: RepoCtx, id: PaymentId): Promise<Payment | null> {
  const [row] = await ctx.db
    .select()
    .from(payments)
    .where(and(eq(payments.businessId, ctx.businessId), eq(payments.id, id)))
    .for("update");
  return row ? toPayment(row) : null;
}

export interface PaymentFilter {
  transferStatus?: TransferStatus;
  limit?: number;
}

/** Newest first; uses the (business_id, transfer_status) index. */
export async function listPayments(ctx: RepoCtx, filter: PaymentFilter = {}): Promise<Payment[]> {
  const conditions: SQL[] = [eq(payments.businessId, ctx.businessId)];
  if (filter.transferStatus) conditions.push(eq(payments.transferStatus, filter.transferStatus));
  const rows = await ctx.db
    .select()
    .from(payments)
    .where(and(...conditions))
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .limit(Math.min(Math.max(filter.limit ?? 100, 1), 500));
  return rows.map(toPayment);
}

export interface TransferUpdate {
  transferId: string;
  /** Written together with `transferUpdatedAt`; decide with `applyTransferUpdate` first. */
  transferStatus: TransferStatus;
  transferUpdatedAt: Date;
  failureType?: string | null;
}

export async function updatePaymentTransfer(
  ctx: RepoCtx,
  id: PaymentId,
  update: TransferUpdate,
): Promise<Payment | null> {
  try {
    const [row] = await ctx.db
      .update(payments)
      .set({
        transferId: update.transferId,
        transferStatus: update.transferStatus,
        transferUpdatedAt: update.transferUpdatedAt,
        failureType: update.failureType ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(payments.businessId, ctx.businessId), eq(payments.id, id)))
      .returning();
    return row ? toPayment(row) : null;
  } catch (error) {
    throw translateDbError(error);
  }
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
