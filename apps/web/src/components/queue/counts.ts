// The queue's summary counts (docs/design/screens/payment-queue.md). Pure, so a test can fill the
// summary string with them. "Reported by Airwallex" means a transfer status Carnet stored from Airwallex;
// a payment whose transfer is being created is "waiting", never counted as sent.
import type { QueueItemDto } from "@/server/queue";

export interface QueueCounts {
  readonly total: number;
  readonly strong: number;
  readonly weak: number;
  readonly missing: number;
  readonly held: number;
  readonly sent: number;
  readonly waiting: number;
  readonly notSent: number;
}

export function queueCounts(items: readonly QueueItemDto[]): QueueCounts {
  const n = (f: (i: QueueItemDto) => boolean) => items.filter(f).length;
  return {
    total: items.length,
    strong: n((i) => i.flag === "strong"),
    weak: n((i) => i.flag === "weak"),
    missing: n((i) => i.flag === "missing"),
    held: n((i) => i.held),
    sent: n((i) => i.payment.transfer_status !== null),
    waiting: n((i) => i.payment.attempt !== null && i.payment.transfer_status === null),
    notSent: n((i) => i.payment.attempt === null && i.payment.transfer_status === null),
  };
}
