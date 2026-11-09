// What a payee may see about a payment (M3-06, STRIDE: information disclosure). The page shows one
// status word and a time, derived from the transfer projection (ADR 0006), never from an RFI directly.
// GENERIC hides a compliance hold: a held payment reads exactly like an ordinary Processing one.
// DELAYED_FOR_VERIFICATION is the owner's per-link opt-in to say "Delayed for verification", and only
// while the payment is held and still moving (SCHEDULED or PROCESSING). SENT, PAID and FAILED always
// use their own words: once money has left or the transfer has ended, the hold wording is wrong.
import { project, type TransferStatus } from "./status";

export const DISCLOSURE_LEVELS = ["GENERIC", "DELAYED_FOR_VERIFICATION"] as const;
export type DisclosureLevel = (typeof DISCLOSURE_LEVELS)[number];

export function isDisclosureLevel(value: string): value is DisclosureLevel {
  return (DISCLOSURE_LEVELS as readonly string[]).includes(value);
}

/** The words a payee can see. The web layer maps each code to its text (apps/web strings). */
export const PAYEE_STATUSES = [
  "PROCESSING",
  "SENT",
  "PAID",
  "FAILED",
  "DELAYED_FOR_VERIFICATION",
] as const;
export type PayeeStatus = (typeof PAYEE_STATUSES)[number];

/**
 * Total over all 11 transfer statuses x {no RFI, open RFI} x both levels. A payment whose transfer
 * does not exist yet (`null`) is Processing. A transfer that will never be sent (approval recalled,
 * rejected or blocked) reads Failed: no payment is coming.
 */
export function payeeStatus(
  transferStatus: TransferStatus | null,
  openRfi: boolean,
  level: DisclosureLevel,
): PayeeStatus {
  if (transferStatus === null) return "PROCESSING";
  const { view, held } = project(transferStatus, openRfi);
  switch (view) {
    case "SENT":
      return "SENT";
    case "PAID":
      return "PAID";
    case "FAILED":
    case "NOT_SENT":
      return "FAILED";
    case "AWAITING_APPROVAL":
    case "OVERDUE":
      return "PROCESSING";
    case "SCHEDULED":
    case "PROCESSING":
      return held && level === "DELAYED_FOR_VERIFICATION"
        ? "DELAYED_FOR_VERIFICATION"
        : "PROCESSING";
    default: {
      const unreachable: never = view;
      throw new Error(`unhandled payment view: ${String(unreachable)}`);
    }
  }
}
