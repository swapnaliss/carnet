// `evaluateAutoApproval` (M3-03): ALLOW or DENY(reason) for one plan action against a policy. Every
// check is required; the first that fails names the reason. A missing limit or cap denies (fail
// closed). No clock: the caller passes `now`, balances, today's total and (at execution) the quote.
import { type Currency, exponentOf } from "../money";
import { minorOf, type Policy } from "./policy";

export const DENY_REASONS = [
  "NOT_CONVERSION",
  "NO_LIMIT",
  "FLOOR_BREACH",
  "PER_ACTION_LIMIT",
  "NO_DAILY_CAP",
  "DAILY_CAP",
  "FEE_MISMATCH",
  "QUOTE_STALE",
  "QUOTE_MISMATCH",
  "SLIPPAGE",
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

/** The conversion a plan action asks for. `indicativeRate` is buy per sell, major units. */
export interface ConversionIntent {
  readonly kind: "convert";
  readonly sellCurrency: Currency;
  readonly buyCurrency: Currency;
  readonly sellMinor: bigint;
  readonly buyMinor: bigint;
  /** The planner's flat SWIFT fee inside `buyMinor` (summed over the payouts it covers). */
  readonly swiftFeeIncludedMinor: bigint;
  readonly obligationCount: number;
  readonly indicativeRate: string;
}

/** Any other action kind: never auto-approved. */
export interface OtherIntent {
  readonly kind: "fund" | "defer" | "escalate" | "payout";
}

export interface QuoteFacts {
  readonly sellCurrency: Currency;
  readonly buyCurrency: Currency;
  readonly sellMinor: bigint;
  readonly buyMinor: bigint;
  /** `valid_from_at`; the freshness window counts from here. */
  readonly issuedAt: Date;
}

export interface AutoApprovalState {
  readonly now: Date;
  readonly balances: readonly { currency: Currency; availableMinor: bigint }[];
  /** Auto-approved sell amount so far today (business time zone), in the sell currency. */
  readonly autoApprovedTodayMinor: bigint;
  /** The flat SWIFT fee of the planner's config (`config/fees.json`) for the buy currency. */
  readonly swiftPayoutFeeMinor: bigint;
  /** Present at execution: the fresh single-use quote. */
  readonly quote?: QuoteFacts;
}

export type AutoApprovalDecision =
  | { readonly decision: "ALLOW"; readonly dailyTotalAfterMinor: bigint }
  | { readonly decision: "DENY"; readonly reason: DenyReason; readonly detail: string };

const deny = (reason: DenyReason, detail: string): AutoApprovalDecision => ({
  decision: "DENY",
  reason,
  detail,
});

function parseDecimal(text: string): { n: bigint; k: number } | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const frac = m[2] ?? "";
  return { n: BigInt((m[1] ?? "0") + frac), k: frac.length };
}

interface QuoteAmounts {
  readonly sellMinor: bigint;
  readonly buyMinor: bigint;
  readonly sell: Currency;
  readonly buy: Currency;
}

/**
 * Whether `buy/sell` (minor amounts of a quote) is within `bps` of `rate` (buy per sell, major units).
 * Exact integer arithmetic: |buy*10^es*10^k - n*sell*10^eb| * 10^4 <= bps * n * sell * 10^eb.
 */
export function rateWithinBps(quote: QuoteAmounts, rate: string, bps: number): boolean {
  const r = parseDecimal(rate);
  if (r === null || r.n === 0n || quote.sellMinor <= 0n) return false;
  const es = 10n ** BigInt(exponentOf(quote.sell));
  const eb = 10n ** BigInt(exponentOf(quote.buy));
  const left = quote.buyMinor * es * 10n ** BigInt(r.k);
  const right = r.n * quote.sellMinor * eb;
  const diff = left > right ? left - right : right - left;
  return diff * 10_000n <= BigInt(bps) * right;
}

/** Whether `buy/sell` lies within [low, high] (buy per sell, major units). */
export function rateWithinBounds(quote: QuoteAmounts, low: string, high: string): boolean {
  const lo = parseDecimal(low);
  const hi = parseDecimal(high);
  if (lo === null || hi === null || quote.sellMinor <= 0n) return false;
  const es = 10n ** BigInt(exponentOf(quote.sell));
  const eb = 10n ** BigInt(exponentOf(quote.buy));
  const num = quote.buyMinor * es;
  const den = quote.sellMinor * eb;
  return num * 10n ** BigInt(lo.k) >= lo.n * den && num * 10n ** BigInt(hi.k) <= hi.n * den;
}

export function evaluateAutoApproval(
  action: ConversionIntent | OtherIntent,
  state: AutoApprovalState,
  policy: Policy,
): AutoApprovalDecision {
  if (action.kind !== "convert") return deny("NOT_CONVERSION", `action kind ${action.kind}`);

  // Reserve floor: the conversion must not take any currency's balance below its floor. A currency
  // that already sits below its floor and is not drawn on is not made worse, so it does not block.
  if (!state.balances.some((b) => b.currency === action.sellCurrency)) {
    return deny("FLOOR_BREACH", `no ${action.sellCurrency} balance to convert from`);
  }
  for (const b of state.balances) {
    const delta =
      b.currency === action.sellCurrency
        ? -action.sellMinor
        : b.currency === action.buyCurrency
          ? action.buyMinor
          : 0n;
    const floor = minorOf(policy.reserveFloor, b.currency) ?? 0n;
    if (delta < 0n && b.availableMinor + delta < floor) {
      return deny("FLOOR_BREACH", `${b.currency} would fall below the reserve floor`);
    }
  }

  const limit = minorOf(policy.perActionLimit, action.sellCurrency);
  if (limit === null) return deny("NO_LIMIT", `no per-action limit for ${action.sellCurrency}`);
  if (action.sellMinor > limit) return deny("PER_ACTION_LIMIT", "amount above the per-action limit");

  const cap = minorOf(policy.dailyCap, action.sellCurrency);
  if (cap === null) return deny("NO_DAILY_CAP", `no daily cap for ${action.sellCurrency}`);
  const totalAfter = state.autoApprovedTodayMinor + action.sellMinor;
  if (totalAfter > cap) return deny("DAILY_CAP", "today's auto-approved total would pass the cap");

  // The conversion carries the planner's flat SWIFT fee: what it includes can be no more than the fee
  // the planner's config (the config the caller passes) allows for the payouts it covers.
  if (
    action.swiftFeeIncludedMinor > action.buyMinor ||
    action.swiftFeeIncludedMinor >
      state.swiftPayoutFeeMinor * BigInt(Math.max(action.obligationCount, 1))
  ) {
    return deny("FEE_MISMATCH", "fee inside the conversion differs from the configured SWIFT fee");
  }

  const q = state.quote;
  if (q !== undefined) {
    if (
      q.sellCurrency !== action.sellCurrency ||
      q.buyCurrency !== action.buyCurrency ||
      q.sellMinor !== action.sellMinor
    ) {
      return deny("QUOTE_MISMATCH", "the quote is not for this conversion");
    }
    if (state.now.getTime() - q.issuedAt.getTime() > policy.quoteFreshnessSeconds * 1000) {
      return deny("QUOTE_STALE", "the quote is older than the freshness window");
    }
    const amounts: QuoteAmounts = {
      sellMinor: q.sellMinor,
      buyMinor: q.buyMinor,
      sell: q.sellCurrency,
      buy: q.buyCurrency,
    };
    if (!rateWithinBps(amounts, action.indicativeRate, policy.slippageBps)) {
      return deny("SLIPPAGE", "the quote's rate is outside the slippage bound");
    }
  }
  return { decision: "ALLOW", dailyTotalAfterMinor: totalAfter };
}
