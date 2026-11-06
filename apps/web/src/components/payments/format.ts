// Display helpers for the payments screens (M1-08). Client-safe: no domain or server imports.

import { currencyExponent, formatDate, formatMoney, type MoneyLike } from "@/lib/intl";
import type { AttemptDto, PaymentDto } from "@/server/payments";
import { fill, locale, t } from "@/strings";

/** Wire money (`{ amount: "25.00", currency: "USD" }`, major units) → minor units, exactly. */
export function wireToMoney(wire: { amount: string; currency: string }): MoneyLike | null {
  let exponent: number;
  try {
    exponent = currencyExponent(wire.currency);
  } catch {
    return null;
  }
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(wire.amount);
  if (!m) return null;
  const fraction = m[3] ?? "";
  if (fraction.length > exponent) return null;
  const minor = BigInt(`${m[2]}${fraction.padEnd(exponent, "0")}`);
  return { minor: m[1] ? -minor : minor, currency: wire.currency };
}

export function formatWire(wire: { amount: string; currency: string }): string {
  const money = wireToMoney(wire);
  return money ? formatMoney(money, locale) : t.money.unavailable;
}

export function formatWhen(value: string): string {
  return formatDate(value, locale, { dateStyle: "medium", timeStyle: "medium" });
}

export type Tone = "neutral" | "progress" | "success" | "warning" | "danger" | "held";

export type StatusIcon =
  | "none"
  | "approval"
  | "undo"
  | "octagon"
  | "ban"
  | "calendar"
  | "alert"
  | "loader"
  | "send"
  | "check"
  | "slash"
  | "help";

export interface StatusDescription {
  /** Changes exactly when what the owner sees changes (used to announce transitions). */
  readonly key: string;
  readonly tone: Tone;
  readonly icon: StatusIcon;
  readonly label: string;
  readonly hint: string;
}

function attemptStatus(attempt: AttemptDto | null): StatusDescription {
  const s = t.status;
  switch (attempt?.status) {
    case "INTENT":
    case "SENT_TO_AIRWALLEX":
    case "CONFIRMED":
      return { key: "attempt:sending", tone: "progress", icon: "send", ...s.attempt.sending };
    case "UNKNOWN":
      return { key: "attempt:unknown", tone: "warning", icon: "alert", ...s.attempt.unknown };
    case "REJECTED":
      return { key: "attempt:rejected", tone: "danger", icon: "octagon", ...s.attempt.rejected };
    default:
      return { key: "none", tone: "neutral", icon: "none", ...s.transfer.none };
  }
}

/** A failure type in plain words ("the bank routing details were not accepted"), never the raw code. */
export function plainReason(type: string | null): string {
  if (!type) return t.status.transfer.failureUnknown;
  const known = (t.status.transfer.failureReasons as Record<string, string>)[type];
  return known ?? type.toLowerCase().replaceAll("_", " ");
}

/**
 * The badge for a payment (docs/design/components.md StatusBadge). The transfer status comes only
 * from what Carnet stored from Airwallex; before a transfer exists, the attempt state is shown.
 */
export function describeStatus(p: PaymentDto): StatusDescription {
  const s = t.status.transfer;
  const reason = plainReason(p.failure_type);
  const of = (
    key: string,
    tone: Tone,
    icon: StatusIcon,
    text: { label: string; hint: string },
  ): StatusDescription => ({ key, tone, icon, label: text.label, hint: text.hint });
  switch (p.transfer_status) {
    case null:
      return attemptStatus(p.attempt);
    case "IN_APPROVAL":
      return of("IN_APPROVAL", "neutral", "approval", s.inApproval);
    case "APPROVAL_RECALLED":
      return of("APPROVAL_RECALLED", "neutral", "undo", s.approvalRecalled);
    case "APPROVAL_REJECTED":
      return of("APPROVAL_REJECTED", "danger", "octagon", s.approvalRejected);
    case "APPROVAL_BLOCKED":
      return of("APPROVAL_BLOCKED", "danger", "ban", s.approvalBlocked);
    case "SCHEDULED":
      return of("SCHEDULED", "progress", "calendar", s.scheduled);
    case "OVERDUE":
      return of("OVERDUE", "warning", "alert", s.overdue);
    case "PROCESSING":
      return of("PROCESSING", "progress", "loader", s.processing);
    case "SENT":
      return of("SENT", "progress", "send", s.sent);
    case "PAID":
      return of("PAID", "success", "check", s.paid);
    case "FAILED":
      return of("FAILED", "danger", "octagon", {
        label: s.failed.label,
        hint: fill(s.failed.hint, { failureReason: reason }),
      });
    case "CANCELLED":
      return p.failure_type
        ? of("CANCELLED_FAILED", "danger", "octagon", {
            label: s.cancelledFailed.label,
            hint: fill(s.cancelledFailed.hint, { failureReason: reason }),
          })
        : of("CANCELLED", "neutral", "slash", s.cancelled);
    default:
      return of(`OTHER:${p.transfer_status}`, "neutral", "help", {
        label: s.unknown.label,
        hint: fill(s.unknown.hint, { raw: p.transfer_status }),
      });
  }
}

/** The polite announcement for a status change (docs/design/accessibility.md "Live regions"). */
export function announcement(p: PaymentDto, status: StatusDescription): string {
  const amount = formatWire(p.amount);
  return p.transfer_status
    ? fill(t.payments.announce.status, { reference: p.reference, amount, status: status.label })
    : fill(t.payments.announce.attempt, { reference: p.reference, amount, state: status.label });
}
