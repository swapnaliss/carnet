// The payment queue's data (M2-03): every payment with the strength of its evidence, next to the
// transfer status Carnet stored from Airwallex. The flag is computed by code on each load
// (src/server/evidence.ts); the status is the projection of the stored transfer and of the open RFI
// (`project`), never invented here. Sorted as docs/design/screens/payment-queue.md says: held first, then
// failures and OVERDUE, then newest (no due dates exist before obligations, M3).
import { listRfis, type RepoCtx } from "@carnet/db";
import { type PaymentId, project, RFI_HOLDING_STATES } from "@carnet/domain";
import { type EvidenceCheckDto, loadEvidenceCheck } from "./evidence";
import { loadPaymentList, type PaymentDto } from "./payments";

export interface QueueItemDto {
  readonly payment: PaymentDto;
  readonly payee: string | null;
  readonly flag: EvidenceCheckDto["flag"];
  /** The first reason in words ("No invoice is linked to this payment."). */
  readonly reason: string;
  /** Documents linked to the payment. */
  readonly documents: number;
  readonly held: boolean;
  /** When Airwallex's information request expires, while the payment is held. */
  readonly rfi_expires_at: string | null;
}

export interface QueueResponse {
  readonly items: QueueItemDto[];
  readonly server_time: string;
}

const FAILED = new Set(["FAILED", "CANCELLED", "OVERDUE", "APPROVAL_REJECTED", "APPROVAL_BLOCKED"]);

export async function loadQueue(repo: RepoCtx, now = new Date()): Promise<QueueResponse> {
  const list = await loadPaymentList(repo, now);
  const holding = await listRfis(repo, { states: [...RFI_HOLDING_STATES], orphan: false });
  const items: QueueItemDto[] = [];
  for (const base of list.items) {
    const loaded = await loadEvidenceCheck(repo, base.id as PaymentId, now);
    if (!loaded) continue;
    const rfi = holding.find((r) => r.paymentId === base.id) ?? null;
    const status = base.transfer_status as Parameters<typeof project>[0] | null;
    const projection = status ? project(status, rfi !== null) : null;
    const payment: PaymentDto = projection
      ? { ...base, view: projection.view, held: projection.held, final: projection.final }
      : base;
    items.push({
      payment,
      payee: loaded.dto.payment.counterparty_name,
      flag: loaded.dto.flag,
      reason: loaded.dto.reasons[0]?.text ?? "",
      documents: loaded.dto.documents.length,
      held: payment.held,
      rfi_expires_at: payment.held ? (rfi?.expiresAt?.toISOString() ?? null) : null,
    });
  }
  const rank = (i: QueueItemDto) =>
    i.held ? 0 : i.payment.transfer_status && FAILED.has(i.payment.transfer_status) ? 1 : 2;
  items.sort((a, b) => rank(a) - rank(b));
  return { items, server_time: list.server_time };
}
