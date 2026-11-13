// Display helpers for the plan screen (M3-04). Client-safe. Money and dates go through `Intl` (lib/intl);
// every sentence comes from the typed strings module.
import type { StatusDescription } from "@/components/payments/format";
import { formatDate, formatMoney } from "@/lib/intl";
import type { ActionDto, Fate } from "@/server/plans";
import { fill, locale, t } from "@/strings";

export const money = (minor: string | bigint, currency: string): string =>
  formatMoney({ minor: BigInt(minor), currency }, locale);

export const signedMoney = (minor: bigint, currency: string): string =>
  formatMoney({ minor, currency }, locale, { signDisplay: "exceptZero" });

export const day = (iso: string): string => formatDate(iso, locale, { dateStyle: "medium" });
export const when = (iso: string): string =>
  formatDate(iso, locale, { dateStyle: "medium", timeStyle: "short" });
export const shortHash = (hash: string): string => hash.slice(0, 8);

function fact(a: ActionDto, key: string): string {
  const v = a.reason_facts[key];
  return typeof v === "string" ? v : "0";
}

function currencyOf(a: ActionDto): string {
  const p = a.params as { currency?: string; sell_currency?: string };
  return p.currency ?? p.sell_currency ?? "";
}

/** The machine reason code as a sentence, from the action's own facts. */
export function reasonText(a: ActionDto): string {
  const c = currencyOf(a);
  const m = (key: string) => money(fact(a, key), c);
  switch (a.reason_code) {
    case "FUNDED_FROM_BALANCE":
      return fill(t.plan.reason.FUNDED_FROM_BALANCE, {
        currency: c,
        spendable: m("spendable_before_minor"),
      });
    case "FUNDED_AFTER_CONVERSION":
      return fill(t.plan.reason.FUNDED_AFTER_CONVERSION, {
        currency: c,
        spendable: m("spendable_before_minor"),
        covered: m("covered_by_conversion_minor"),
      });
    case "PAYOUT_ALTERNATE_FOR_HELD":
      return t.plan.reason.PAYOUT_ALTERNATE_FOR_HELD;
    case "CONVERT_SHORTFALL": {
      const p = a.params as { buy_currency: string };
      return fill(t.plan.reason.CONVERT_SHORTFALL, {
        fee: money(fact(a, "swift_fee_included_minor"), p.buy_currency),
        bps: String(a.reason_facts.fx_spread_bps ?? 0),
      });
    }
    case "DEFER_SHORT_OF_CASH":
      return fill(t.plan.reason.DEFER_SHORT_OF_CASH, {
        spendable: m("spendable_minor"),
        needed: m("needed_minor"),
        days: String(a.reason_facts.grace_days ?? 0),
      });
    case "DEFER_BEHIND_UNFUNDED":
      return fill(t.plan.reason.DEFER_BEHIND_UNFUNDED, { currency: c });
    case "ESCALATE_CRITICAL_SHORT":
      return fill(t.plan.reason.ESCALATE_CRITICAL_SHORT, { shortfall: m("shortfall_minor") });
    case "ESCALATE_UNCONFIRMED_SHORT":
      return fill(t.plan.reason.ESCALATE_UNCONFIRMED_SHORT, { shortfall: m("shortfall_minor") });
    case "ESCALATE_NO_DEFERRAL_WINDOW":
      return fill(t.plan.reason.ESCALATE_NO_DEFERRAL_WINDOW, { shortfall: m("shortfall_minor") });
    default:
      return a.reason_code;
  }
}

export function fateLabel(fate: Fate): string {
  return t.plan.fate[fate];
}

/** An action's approval state as a StatusBadge description (icon and words, never colour alone). */
export function actionStatus(a: ActionDto): StatusDescription {
  const s = t.plan.state;
  switch (a.state) {
    case "APPROVED":
      return { key: "approved", tone: "progress", icon: "approval", ...s.APPROVED };
    case "AUTO_APPROVED":
      return { key: "auto", tone: "progress", icon: "check", ...s.AUTO_APPROVED };
    case "EXECUTING":
      return { key: "executing", tone: "progress", icon: "send", ...s.EXECUTING };
    case "DONE":
      return { key: "done", tone: "success", icon: "check", ...s.DONE };
    case "FAILED":
      return { key: "failed", tone: "danger", icon: "octagon", ...s.FAILED };
    case "SUPERSEDED":
      return { key: "superseded", tone: "neutral", icon: "slash", ...s.SUPERSEDED };
    default:
      break;
  }
  if (a.approvable)
    return { key: "needs-approval", tone: "warning", icon: "approval", ...s.PROPOSED };
  if (a.kind === "fund") return { key: "planned", tone: "neutral", icon: "none", ...s.PLANNED };
  if (a.kind === "convert" && a.state_reason) {
    const denial = (t.plan.denial as Record<string, string>)[a.state_reason] ?? a.state_reason;
    return {
      key: "not-auto",
      tone: "neutral",
      icon: "approval",
      label: s.PROPOSED.label,
      hint: fill(t.plan.state.notAuto, { reason: denial }),
    };
  }
  return { key: "recommended", tone: "neutral", icon: "none", ...s.RECOMMENDED };
}
