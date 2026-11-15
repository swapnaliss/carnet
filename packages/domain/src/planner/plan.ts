// The planner (M3-02, pillar 3). A pure, total, deterministic function: no clock, no randomness, no
// I/O, no model (ADR 0001, 0009). Code decides every amount and every ordering; the reasons it
// returns are the numbers it used.
//
// Rules, in the order the code applies them:
//  1. Obligations of the plan's business are processed by (criticality asc, due_at asc, id). An
//     UNCONFIRMED criticality counts as 1 for the cash it reserves and is never deferred.
//  2. Cash per currency is `available - held (unless the balance already excludes it) - floor`,
//     never below zero. Currencies are never added together: a shortfall in one currency is covered
//     only by a `convert` action from another, priced at the worst-case rate.
//  3. An obligation is funded (`fund`, or `payout` when its payment is held) if its cash covers the
//     amount plus the flat SWIFT fee, otherwise the shortfall is converted from the first currency
//     that can cover it: currencies the policy has a per-action auto-convert limit for come first (a
//     conversion from them could run without a person), then the rest; alphabetical within each group
//     (ADR 0021 amendment 1). Conversions of one pair are merged into one action.
//  4. Otherwise a confirmed criticality 2 or 3 whose due date plus grace is still ahead is deferred;
//     everything else is escalated to the owner. Once an obligation in a currency is not funded,
//     later ones in that currency are not funded either (strict priority, no queue jumping).
import { type Currency, exponentOf } from "../money";
import type { Criticality, PlanAction, PlanInputs, ReasonCode, ReasonFacts } from "./schemas";
import { canonicalJson, sha256Hex } from "./sha256";

const DAY_MS = 86_400_000;
const BPS = 10_000n;
const RATE_DIGITS = 8;

type Draft = PlanAction extends infer A ? (A extends PlanAction ? Omit<A, "seq"> : never) : never;

interface Rate {
  readonly n: bigint;
  readonly k: number;
  readonly text: string;
  readonly asOf: string;
}

interface Conversion {
  readonly sell: Currency;
  readonly buy: Currency;
  readonly rate: Rate;
  buyMinor: bigint;
  sellMinor: bigint;
  feeIncluded: bigint;
  readonly obligationIds: string[];
  readonly sourceBefore: bigint;
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;
const str = (v: bigint): string => v.toString();
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function parseRate(text: string, asOf: string): Rate {
  const [whole = "0", frac = ""] = text.split(".");
  return { n: BigInt(whole + frac), k: frac.length, text, asOf };
}

/** `numerator / denominator` as a decimal string with RATE_DIGITS places, rounded down or up. */
function formatRatio(numerator: bigint, denominator: bigint, up: boolean): string {
  const scaled = numerator * pow10(RATE_DIGITS);
  const q = up ? ceilDiv(scaled, denominator) : scaled / denominator;
  const unit = pow10(RATE_DIGITS);
  return `${q / unit}.${(q % unit).toString().padStart(RATE_DIGITS, "0")}`;
}

/** Smallest sell amount (minor) that buys at least `buy` (minor) at the worst-case rate. */
function sellFor(rate: Rate, sell: Currency, buy: Currency, buyMinor: bigint, bps: bigint): bigint {
  const num = buyMinor * pow10(exponentOf(sell)) * pow10(rate.k) * BPS;
  const den = rate.n * (BPS - bps) * pow10(exponentOf(buy));
  return ceilDiv(num, den);
}

function criticalityUsed(c: Criticality): 1 | 2 | 3 {
  return c === "UNCONFIRMED" ? 1 : c;
}

/** The decisions for already validated inputs, in plan order, without sequence numbers. */
export function decide(inputs: PlanInputs): Draft[] {
  const biz = inputs.businessId;
  const bps = BigInt(inputs.config.fxSpreadBps);
  const nowMs = Date.parse(inputs.now);
  const visible = inputs.config.heldFundsVisibleInBalances;

  const heldBy = new Map<Currency, bigint>();
  const heldPayments = new Set<string>();
  for (const h of inputs.held) {
    if (h.businessId !== biz) continue;
    heldPayments.add(h.paymentId);
    heldBy.set(h.currency, (heldBy.get(h.currency) ?? 0n) + h.amountMinor);
  }
  const floorBy = new Map<Currency, bigint>();
  for (const f of inputs.reserveFloor) if (f.businessId === biz) floorBy.set(f.currency, f.minor);
  const availableBy = new Map<Currency, bigint>();
  for (const b of inputs.balances)
    if (b.businessId === biz) availableBy.set(b.currency, b.availableMinor);

  const spendable = new Map<Currency, bigint>();
  const cash = (c: Currency): bigint => {
    let v = spendable.get(c);
    if (v === undefined) {
      const raw =
        (availableBy.get(c) ?? 0n) -
        (visible ? 0n : (heldBy.get(c) ?? 0n)) -
        (floorBy.get(c) ?? 0n);
      v = raw > 0n ? raw : 0n;
      spendable.set(c, v);
    }
    return v;
  };

  const feeBy = new Map(inputs.config.swiftPayoutFee.map((f) => [f.currency, f.minor]));
  const limitBy = new Map(inputs.policy.autoConvertLimits.map((f) => [f.currency, f.minor]));
  const rates = new Map(
    inputs.fxRates.map((r) => [`${r.sell}>${r.buy}`, parseRate(r.rate, r.asOf)] as const),
  );
  // Sources the policy can auto-approve first, then alphabetical (ADR 0021 amendment 1). Without a
  // policy (no limits) this is the alphabetical order of before.
  const sources = [...new Set(inputs.fxRates.map((r) => r.sell))].sort(
    (a, b) => Number(!limitBy.has(a)) - Number(!limitBy.has(b)) || cmp(a, b),
  );

  const ordered = inputs.obligations
    .filter((o) => o.businessId === biz)
    .sort(
      (a, b) =>
        criticalityUsed(a.criticality) - criticalityUsed(b.criticality) ||
        cmp(a.dueAt, b.dueAt) ||
        cmp(a.id, b.id),
    );

  const conversions = new Map<string, Conversion>();
  const blocked = new Map<Currency, string>();
  const decisions: Draft[] = [];

  for (const o of ordered) {
    const c = o.currency;
    const fee = o.payoutMethod === "SWIFT" ? (feeBy.get(c) ?? 0n) : 0n;
    const need = o.amountMinor + fee;
    const have = cash(c);
    const unconfirmed = o.criticality === "UNCONFIRMED";
    const label = String(o.criticality) as "1" | "2" | "3" | "UNCONFIRMED";
    const heldPaymentId =
      o.paymentId !== null && heldPayments.has(o.paymentId) ? o.paymentId : null;
    const shortfall = need > have ? need - have : 0n;
    const blockedBy = blocked.get(c) ?? null;

    let converted: Conversion | null = null;
    if (shortfall > 0n && blockedBy === null) {
      for (const s of sources) {
        if (s === c) continue;
        const rate = rates.get(`${s}>${c}`);
        if (!rate) continue;
        const key = `${s}>${c}`;
        const prior = conversions.get(key);
        const newBuy = (prior?.buyMinor ?? 0n) + shortfall;
        const newSell = sellFor(rate, s, c, newBuy, bps);
        const increment = newSell - (prior?.sellMinor ?? 0n);
        if (cash(s) < increment) continue;
        const conv: Conversion = prior ?? {
          sell: s,
          buy: c,
          rate,
          buyMinor: 0n,
          sellMinor: 0n,
          feeIncluded: 0n,
          obligationIds: [],
          sourceBefore: cash(s),
        };
        conv.buyMinor = newBuy;
        conv.sellMinor = newSell;
        conv.feeIncluded += fee < shortfall ? fee : shortfall;
        conv.obligationIds.push(o.id);
        conversions.set(key, conv);
        spendable.set(s, cash(s) - increment);
        converted = conv;
        break;
      }
    }

    const base = {
      obligation_id: o.id,
      payee: o.payee,
      currency: c,
      amount_minor: str(o.amountMinor),
      criticality: label,
    };

    if (blockedBy === null && (shortfall === 0n || converted !== null)) {
      spendable.set(c, have + shortfall - need);
      const facts: ReasonFacts = {
        available_minor: str(availableBy.get(c) ?? 0n),
        held_minor: str(heldBy.get(c) ?? 0n),
        held_counted_by_planner: !visible,
        reserve_floor_minor: str(floorBy.get(c) ?? 0n),
        spendable_before_minor: str(have),
        amount_minor: str(o.amountMinor),
        swift_fee_minor: str(fee),
        reserved_minor: str(need),
        covered_by_conversion_minor: str(shortfall),
        criticality_used: criticalityUsed(o.criticality),
      };
      const common = {
        reserved_minor: str(need),
        fee_minor: str(fee),
        criticality_unconfirmed: unconfirmed,
      };
      if (heldPaymentId !== null) {
        decisions.push({
          kind: "payout",
          reason_code: "PAYOUT_ALTERNATE_FOR_HELD",
          reason_facts: { ...facts, held_payment_id: heldPaymentId },
          needs_approval: true,
          params: { ...base, ...common, held_payment_id: heldPaymentId },
        });
      } else {
        decisions.push({
          kind: "fund",
          reason_code: converted ? "FUNDED_AFTER_CONVERSION" : "FUNDED_FROM_BALANCE",
          reason_facts: facts,
          needs_approval: false,
          params: { ...base, ...common },
        });
      }
      continue;
    }

    // Not funded: nothing is reserved, and later obligations in this currency queue behind it.
    if (blockedBy === null) blocked.set(c, o.id);
    const facts: ReasonFacts = {
      available_minor: str(availableBy.get(c) ?? 0n),
      held_minor: str(heldBy.get(c) ?? 0n),
      held_counted_by_planner: !visible,
      reserve_floor_minor: str(floorBy.get(c) ?? 0n),
      spendable_minor: str(have),
      needed_minor: str(need),
      shortfall_minor: str(shortfall),
      behind_unfunded_obligation_id: blockedBy,
      criticality_used: criticalityUsed(o.criticality),
    };
    const dueMs = Date.parse(o.dueAt);
    const grace =
      o.criticality === 2
        ? inputs.config.deferGraceDays["2"]
        : o.criticality === 3
          ? inputs.config.deferGraceDays["3"]
          : 0;
    if (!unconfirmed && o.criticality !== 1 && grace > 0 && dueMs + grace * DAY_MS >= nowMs) {
      const proposed = new Date(dueMs + grace * DAY_MS).toISOString();
      decisions.push({
        kind: "defer",
        reason_code: blockedBy === null ? "DEFER_SHORT_OF_CASH" : "DEFER_BEHIND_UNFUNDED",
        reason_facts: { ...facts, grace_days: grace },
        needs_approval: true,
        params: { ...base, current_due_at: o.dueAt, proposed_due_at: proposed },
      });
      continue;
    }
    const code: ReasonCode = unconfirmed
      ? "ESCALATE_UNCONFIRMED_SHORT"
      : o.criticality === 1
        ? "ESCALATE_CRITICAL_SHORT"
        : "ESCALATE_NO_DEFERRAL_WINDOW";
    decisions.push({
      kind: "escalate",
      reason_code: code,
      reason_facts: facts,
      needs_approval: true,
      params: { ...base, shortfall_minor: str(shortfall), criticality_unconfirmed: unconfirmed },
    });
  }

  const converts: Draft[] = [...conversions.values()]
    .sort((a, b) => cmp(`${a.sell}>${a.buy}`, `${b.sell}>${b.buy}`))
    .map((v): Draft => {
      const { n, k } = v.rate;
      const unit = pow10(k) * BPS;
      const limit = limitBy.get(v.sell);
      const autoEligible = limit !== undefined && v.sellMinor <= limit;
      const rateLow = formatRatio(n * (BPS - bps), unit, false);
      const rateHigh = formatRatio(n * (BPS + bps), unit, true);
      return {
        kind: "convert",
        reason_code: "CONVERT_SHORTFALL",
        reason_facts: {
          sell_currency: v.sell,
          buy_currency: v.buy,
          sell_minor: str(v.sellMinor),
          buy_minor: str(v.buyMinor),
          swift_fee_included_minor: str(v.feeIncluded),
          fx_spread_bps: inputs.config.fxSpreadBps,
          rate: v.rate.text,
          rate_low: rateLow,
          source_spendable_before_minor: str(v.sourceBefore),
          source_spendable_after_minor: str(v.sourceBefore - v.sellMinor),
          reserve_floor_minor: str(floorBy.get(v.sell) ?? 0n),
          auto_convert_limit_minor: limit === undefined ? null : str(limit),
        },
        needs_approval: !autoEligible,
        params: {
          sell_currency: v.sell,
          buy_currency: v.buy,
          sell_minor: str(v.sellMinor),
          buy_minor: str(v.buyMinor),
          swift_fee_included_minor: str(v.feeIncluded),
          rate: v.rate.text,
          rate_low: rateLow,
          rate_high: rateHigh,
          rate_as_of: v.rate.asOf,
          auto_eligible: autoEligible,
          obligation_ids: [...v.obligationIds],
        },
      };
    });

  return [...converts, ...decisions];
}

/** Number the decisions 1..n. */
export function sequence(drafts: readonly Draft[]): PlanAction[] {
  return drafts.map((d, i) => ({ ...d, seq: i + 1 }) as PlanAction);
}

/** Hash of the decisions alone: equal for equal plans whatever their revision or inputs. */
export function contentHash(inputs: PlanInputs, actions: readonly PlanAction[]): string {
  return sha256Hex(
    canonicalJson([inputs.businessId, inputs.policy.version, inputs.policy.hash, actions]),
  );
}
