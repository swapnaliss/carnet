// The payment queue's data (M2-03): every payment with the strength of its evidence, next to the
// transfer status Carnet stored from Airwallex. The flag is computed by code on each load
// (src/server/evidence.ts); the status is the projection of the stored transfer, never invented here.
import type { RepoCtx } from "@carnet/db";
import type { PaymentId } from "@carnet/domain";
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
}

export interface QueueResponse {
  readonly items: QueueItemDto[];
  readonly server_time: string;
}

export async function loadQueue(repo: RepoCtx, now = new Date()): Promise<QueueResponse> {
  const list = await loadPaymentList(repo, now);
  const items: QueueItemDto[] = [];
  for (const payment of list.items) {
    const loaded = await loadEvidenceCheck(repo, payment.id as PaymentId, now);
    if (!loaded) continue;
    items.push({
      payment,
      payee: loaded.dto.payment.counterparty_name,
      flag: loaded.dto.flag,
      reason: loaded.dto.reasons[0]?.text ?? "",
      documents: loaded.dto.documents.length,
    });
  }
  return { items, server_time: list.server_time };
}
