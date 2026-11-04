// Payment status is a projection of (Airwallex transfer status, open RFI) (ADR 0006). The RFI only
// sets the `held` flag; it never changes the view, so an RFI can never make a payment SENT, PAID or
// FAILED. Stored transfer state only moves forward through applyTransferUpdate.

/** All eleven Airwallex transfer statuses, in rank order (lowest first). */
export const TRANSFER_STATUSES = [
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

export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export function isTransferStatus(value: string): value is TransferStatus {
  return (TRANSFER_STATUSES as readonly string[]).includes(value);
}

/**
 * Status rank: a later lifecycle stage has a higher rank, and every status has a distinct rank.
 * FAILED and CANCELLED rank above PAID (PAID can still fail); CANCELLED ranks above FAILED because a
 * failed transfer is reported FAILED and then CANCELLED, often within the same `updated_at` second.
 */
export function rank(status: TransferStatus): number {
  return TRANSFER_STATUSES.indexOf(status);
}

/** What the owner sees. CANCELLED projects to FAILED: a failed transfer ends CANCELLED. */
export type PaymentView =
  | "AWAITING_APPROVAL"
  | "NOT_SENT"
  | "SCHEDULED"
  | "OVERDUE"
  | "PROCESSING"
  | "SENT"
  | "PAID"
  | "FAILED";

export interface PaymentProjection {
  readonly view: PaymentView;
  /** An open RFI is holding money that is in flight (SCHEDULED, PROCESSING or SENT). */
  readonly held: boolean;
  /** No further transfer status change is expected. PAID is not final: it can still fail. */
  readonly final: boolean;
}

export function assertNever(value: never): never {
  throw new Error(`unhandled value: ${String(value)}`);
}

function base(status: TransferStatus): { view: PaymentView; inFlight: boolean; final: boolean } {
  switch (status) {
    case "IN_APPROVAL":
      return { view: "AWAITING_APPROVAL", inFlight: false, final: false };
    case "APPROVAL_RECALLED":
    case "APPROVAL_REJECTED":
    case "APPROVAL_BLOCKED":
      return { view: "NOT_SENT", inFlight: false, final: true };
    case "SCHEDULED":
      return { view: "SCHEDULED", inFlight: true, final: false };
    case "OVERDUE":
      return { view: "OVERDUE", inFlight: false, final: false };
    case "PROCESSING":
      return { view: "PROCESSING", inFlight: true, final: false };
    case "SENT":
      return { view: "SENT", inFlight: true, final: false };
    case "PAID":
      return { view: "PAID", inFlight: false, final: false };
    case "FAILED":
    case "CANCELLED":
      return { view: "FAILED", inFlight: false, final: true };
    default:
      return assertNever(status);
  }
}

/** Total over all 11 statuses x {no RFI, open RFI}. */
export function project(transferStatus: TransferStatus, openRfi: boolean): PaymentProjection {
  const b = base(transferStatus);
  return { view: b.view, held: openRfi && b.inFlight, final: b.final };
}

/** The part of a transfer the guard needs; callers may carry more fields (failure, amounts). */
export interface TransferSnapshot {
  readonly status: TransferStatus;
  readonly updatedAt: Date;
}

export interface TransferIncident {
  readonly kind: "PAID_THEN_FAILED";
  readonly from: "PAID";
  readonly to: "FAILED" | "CANCELLED";
  readonly at: Date;
}

export type IgnoreReason = "duplicate" | "older_updated_at" | "lower_rank";

export type TransferUpdateResult<T extends TransferSnapshot> =
  | { readonly outcome: "applied"; readonly state: T; readonly incident: TransferIncident | null }
  | { readonly outcome: "ignored"; readonly state: T; readonly reason: IgnoreReason };

/**
 * Apply a fetched transfer state over the stored one. Ignores an incoming state whose `updated_at`
 * is older or whose rank is lower than the stored one (equal `updated_at` resolves by rank), and an
 * exact duplicate. A transfer that moves from PAID to FAILED or CANCELLED is applied and returns an
 * incident marker.
 */
export function applyTransferUpdate<T extends TransferSnapshot>(
  stored: T | null,
  incoming: T,
): TransferUpdateResult<T> {
  if (stored === null) return { outcome: "applied", state: incoming, incident: null };
  const dt = incoming.updatedAt.getTime() - stored.updatedAt.getTime();
  const dr = rank(incoming.status) - rank(stored.status);
  if (dt < 0) return { outcome: "ignored", state: stored, reason: "older_updated_at" };
  if (dr < 0) return { outcome: "ignored", state: stored, reason: "lower_rank" };
  if (dt === 0 && dr === 0) return { outcome: "ignored", state: stored, reason: "duplicate" };
  const incident: TransferIncident | null =
    stored.status === "PAID" && (incoming.status === "FAILED" || incoming.status === "CANCELLED")
      ? { kind: "PAID_THEN_FAILED", from: "PAID", to: incoming.status, at: incoming.updatedAt }
      : null;
  return { outcome: "applied", state: incoming, incident };
}
