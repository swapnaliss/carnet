// RFI → payment matching (M2-04). Pure: the caller passes the questions' sources and a lookup of the
// business's own payments by transfer id (never another business's, so a foreign transfer id is simply
// unknown here).
//
// A question whose sources contain a TRANSFER id mapped to one of the business's payments links the RFI
// to that payment. Everything else goes to the orphan (account-level) queue with a reason code.
// Note (M0-04, BL-01 6600618153): the sandbox keeps only the first source of a question created with two,
// so a multi-source question is not reproducible live; MULTIPLE_PAYMENTS is reached by questions whose
// (single) sources map to different payments, or by an injected RFI.

export const RFI_ORPHAN_REASONS = [
  /** No question carries any source. */
  "NO_SOURCES",
  /** Sources exist, none is a TRANSFER (for example a DEPOSIT or a CHARGE). */
  "NON_TRANSFER_SOURCE",
  /** TRANSFER sources exist, none maps to a payment of this business. */
  "UNKNOWN_TRANSFER",
  /** TRANSFER sources map to more than one payment of this business. */
  "MULTIPLE_PAYMENTS",
  /** The owner removed a link explicitly. */
  "OWNER_UNLINKED",
] as const;
export type RfiOrphanReason = (typeof RFI_ORPHAN_REASONS)[number];

export interface RfiSourceRef {
  readonly id: string;
  readonly type: string;
}

export type RfiMatch<P extends string = string> =
  | { readonly kind: "linked"; readonly paymentId: P; readonly transferId: string }
  | { readonly kind: "orphan"; readonly reason: RfiOrphanReason };

/** Every source on the RFI's questions, de-duplicated, in a stable order. */
export function distinctSources(questions: readonly { sources: readonly RfiSourceRef[] }[]) {
  const seen = new Map<string, RfiSourceRef>();
  for (const q of questions) {
    for (const s of q.sources) seen.set(`${s.type}:${s.id}`, { id: s.id, type: s.type });
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s);
}

export function matchRfiToPayment<P extends string>(
  questions: readonly { sources: readonly RfiSourceRef[] }[],
  paymentByTransferId: (transferId: string) => P | null,
): RfiMatch<P> {
  const sources = distinctSources(questions);
  if (sources.length === 0) return { kind: "orphan", reason: "NO_SOURCES" };
  const transfers = sources.filter((s) => s.type === "TRANSFER");
  if (transfers.length === 0) return { kind: "orphan", reason: "NON_TRANSFER_SOURCE" };
  const hits = new Map<P, string>();
  for (const t of transfers) {
    const paymentId = paymentByTransferId(t.id);
    if (paymentId !== null && !hits.has(paymentId)) hits.set(paymentId, t.id);
  }
  if (hits.size === 0) return { kind: "orphan", reason: "UNKNOWN_TRANSFER" };
  if (hits.size > 1) return { kind: "orphan", reason: "MULTIPLE_PAYMENTS" };
  const [[paymentId, transferId]] = [...hits.entries()] as [[P, string]];
  return { kind: "linked", paymentId, transferId };
}

/**
 * The per-source guard key (ADR 0018 amendment 1): the sorted `TYPE:id` sources, or null when the RFI has
 * none (those coexist at the provider and are not guarded).
 */
export function rfiSourceKey(
  questions: readonly { sources: readonly RfiSourceRef[] }[],
): string | null {
  const sources = distinctSources(questions);
  return sources.length === 0 ? null : sources.map((s) => `${s.type}:${s.id}`).join(",");
}
