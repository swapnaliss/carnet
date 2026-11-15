// Reconciler lookups (ADR 0005, 0007; M1-05). A webhook or a poll names a provider object (a
// transfer id or a request_id), not a tenant, so the worker first finds which business owns it.
// These functions take `db` and return the owning business id with each row; the caller then works
// through a tenant context (`repoCtx(db, businessId)`). Nothing here is reachable from a request.
import type { BusinessId, PaymentId, RequestId } from "@carnet/domain";
import { and, asc, eq, inArray, isNotNull, isNull, notInArray, notLike, or } from "drizzle-orm";
import type { Db } from "../client";
import { type AttemptKind, type AttemptStatus, executionAttempts, payments } from "../schema/index";

export interface PaymentRef {
  readonly businessId: BusinessId;
  readonly paymentId: PaymentId;
}

/**
 * The payment a transfer belongs to: by `payments.transfer_id`, else through the transfer attempt
 * whose `request_id` matches (the transfer id is not stored until the create call returns).
 */
export async function findPaymentForTransfer(
  db: Db,
  transfer: { transferId: string; requestId?: string | null },
): Promise<PaymentRef | null> {
  const [byTransfer] = await db
    .select({ businessId: payments.businessId, paymentId: payments.id })
    .from(payments)
    .where(eq(payments.transferId, transfer.transferId));
  if (byTransfer) {
    return {
      businessId: byTransfer.businessId as BusinessId,
      paymentId: byTransfer.paymentId as PaymentId,
    };
  }
  if (!transfer.requestId || !UUID.test(transfer.requestId)) return null;
  const [byAttempt] = await db
    .select({ businessId: executionAttempts.businessId, refId: executionAttempts.refId })
    .from(executionAttempts)
    .where(
      and(
        eq(executionAttempts.requestId, transfer.requestId),
        eq(executionAttempts.kind, "transfer"),
      ),
    );
  if (!byAttempt) return null;
  return {
    businessId: byAttempt.businessId as BusinessId,
    paymentId: byAttempt.refId as PaymentId,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Transfer statuses after which nothing changes (PAID is not one: PAID can still fail). */
const SETTLED_TRANSFER_STATUSES = [
  "APPROVAL_RECALLED",
  "APPROVAL_REJECTED",
  "APPROVAL_BLOCKED",
  "FAILED",
  "CANCELLED",
];

export interface OpenTransferRef extends PaymentRef {
  readonly transferId: string;
}

/** Transfer ids of payments materialized from a recording (scripts/replay): never sent to Airwallex. */
export const REPLAY_TRANSFER_PREFIX = "replay-";

/** Payments with a transfer that can still change, oldest update first (the reconcile poll). */
export async function listOpenTransfers(db: Db, limit = 100): Promise<OpenTransferRef[]> {
  const rows = await db
    .select({
      businessId: payments.businessId,
      paymentId: payments.id,
      transferId: payments.transferId,
    })
    .from(payments)
    .where(
      and(
        isNotNull(payments.transferId),
        notLike(payments.transferId, `${REPLAY_TRANSFER_PREFIX}%`),
        or(
          notInArray(payments.transferStatus, SETTLED_TRANSFER_STATUSES),
          // a stored transfer id with no status yet
          isNull(payments.transferStatus),
        ),
      ),
    )
    .orderBy(asc(payments.transferUpdatedAt), asc(payments.id))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.flatMap((r) =>
    r.transferId === null
      ? []
      : [
          {
            businessId: r.businessId as BusinessId,
            paymentId: r.paymentId as PaymentId,
            transferId: r.transferId,
          },
        ],
  );
}

export interface AttemptRef {
  readonly id: string;
  readonly businessId: BusinessId;
  readonly kind: AttemptKind;
  readonly refId: string;
  readonly requestId: RequestId;
  readonly status: AttemptStatus;
}

/** Attempts in the given statuses across tenants, oldest first (the reconciler resolves UNKNOWN). */
export async function listAttemptsByStatus(
  db: Db,
  statuses: readonly AttemptStatus[],
  limit = 100,
): Promise<AttemptRef[]> {
  if (statuses.length === 0) return [];
  const rows = await db
    .select()
    .from(executionAttempts)
    .where(inArray(executionAttempts.status, [...statuses]))
    .orderBy(asc(executionAttempts.createdAt), asc(executionAttempts.id))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map((r) => ({
    id: r.id,
    businessId: r.businessId as BusinessId,
    kind: r.kind,
    refId: r.refId,
    requestId: r.requestId as RequestId,
    status: r.status,
  }));
}
