// `transfer.sync` (ADR 0006): fetch the transfer and apply it to its payment through
// `applyTransferUpdate`. The webhook payload's status is never read: events arrive out of order and
// twice (a failure sends FAILED then CANCELLED; funding events carry the transfer too), so the only
// input is the fetched object, compared against the stored (status, updated_at) under a row lock.
import type { Transfer } from "@carnet/airwallex";
import {
  appendAudit,
  findPaymentForTransfer,
  getPaymentForUpdate,
  markWebhookEventProcessed,
  type PaymentRef,
  repoCtx,
  updatePaymentTransfer,
  withTransaction,
} from "@carnet/db";
import { applyTransferUpdate, type TransferStatus } from "@carnet/domain";
import {
  type HandlerContext,
  type JobHandler,
  payloadOptionalString,
  payloadString,
} from "./index";

export type TransferApplyOutcome =
  | { outcome: "applied"; status: TransferStatus; incident: boolean }
  | { outcome: "ignored"; reason: string }
  | { outcome: "no_payment" };

/** Airwallex `updated_at` is "2026-11-04T06:05:50+0000" (1-second resolution). */
export function parseAirwallexTime(value: string): Date {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`unparseable Airwallex timestamp: ${value}`);
  return new Date(ms);
}

/** Applies a fetched transfer to the payment that owns it (by transfer id or request_id). */
export async function applyFetchedTransfer(
  ctx: HandlerContext,
  transfer: Transfer,
  known?: PaymentRef,
): Promise<TransferApplyOutcome> {
  const owner =
    known ??
    (await findPaymentForTransfer(ctx.db, {
      transferId: transfer.id,
      requestId: transfer.requestId,
    }));
  if (!owner) {
    ctx.logger.info(
      { transferId: transfer.id },
      "transfer has no Carnet payment; nothing to apply",
    );
    return { outcome: "no_payment" };
  }
  const incoming = { status: transfer.status, updatedAt: parseAirwallexTime(transfer.updatedAt) };

  return withTransaction(ctx.db, async (tx) => {
    const rc = repoCtx(tx, owner.businessId);
    const payment = await getPaymentForUpdate(rc, owner.paymentId);
    if (!payment) return { outcome: "no_payment" } as const;
    if (payment.transferId !== null && payment.transferId !== transfer.id) {
      ctx.logger.warn(
        { paymentId: payment.id, storedTransferId: payment.transferId, transferId: transfer.id },
        "payment is linked to a different transfer; ignored",
      );
      return { outcome: "ignored", reason: "transfer_mismatch" } as const;
    }
    const stored =
      payment.transferStatus !== null && payment.transferUpdatedAt !== null
        ? { status: payment.transferStatus, updatedAt: payment.transferUpdatedAt }
        : null;
    const result = applyTransferUpdate(stored, incoming);
    if (result.outcome === "ignored") {
      ctx.logger.debug(
        { paymentId: payment.id, transferId: transfer.id, reason: result.reason },
        "stale or duplicate transfer state ignored",
      );
      return { outcome: "ignored", reason: result.reason } as const;
    }
    await updatePaymentTransfer(rc, payment.id, {
      transferId: transfer.id,
      transferStatus: incoming.status,
      transferUpdatedAt: incoming.updatedAt,
      failureType: transfer.failure?.type ?? null,
    });
    if (result.incident) {
      const data = {
        kind: result.incident.kind,
        transferId: transfer.id,
        from: result.incident.from,
        to: result.incident.to,
        at: result.incident.at.toISOString(),
        failure: transfer.failure,
      };
      await appendAudit(rc, {
        actorType: "system",
        actorId: "worker",
        action: "incident.paid_then_failed",
        subject: `payment:${payment.id}`,
        data,
      });
      ctx.logger.error(
        { incident: result.incident.kind, paymentId: payment.id, ...data },
        "incident: transfer failed after PAID",
      );
    }
    ctx.logger.info(
      {
        paymentId: payment.id,
        transferId: transfer.id,
        from: stored?.status ?? null,
        to: incoming.status,
      },
      "transfer status applied",
    );
    return {
      outcome: "applied",
      status: incoming.status,
      incident: result.incident !== null,
    } as const;
  });
}

/** Fetches the transfer by id and applies it. */
export async function syncTransfer(
  ctx: HandlerContext,
  transferId: string,
  known?: PaymentRef,
): Promise<TransferApplyOutcome> {
  const transfer = await ctx.airwallex.getTransfer(transferId);
  return applyFetchedTransfer(ctx, transfer, known);
}

/** Payload: `{ transferId, webhookEventId? }`. */
export const handleTransferSync: JobHandler = async (payload, ctx) => {
  const transferId = payloadString(payload, "transferId");
  await syncTransfer(ctx, transferId);
  const eventId = payloadOptionalString(payload, "webhookEventId");
  if (eventId) await markWebhookEventProcessed(ctx.db, eventId);
};
