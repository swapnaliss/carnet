// The plan's plain-language explanation (M3-04, ADR 0009: no model call). `renderExplanation` fills a
// fixed template from the plan's own facts; `verifyExplanation` then extracts every amount, currency,
// number and date from a text and checks each against the same plan, so a text that was altered, or
// written from anything but the plan, is refused and the screen shows the raw reasons instead.
// Pure: no I/O, no framework.
import { type Currency, exponentOf, isCurrency } from "../money";
import type { Plan, PlanAction } from "./schemas";

/** `1234567` minor units in a 2-decimal currency becomes `12,345.67`. Exact: no floating point. */
export function groupMinor(minor: bigint, currency: Currency): string {
  const exponent = exponentOf(currency);
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${exponent > 0 ? `.${fraction}` : ""}`;
}

function amount(currency: string, minor: string): string {
  return `${currency} ${groupMinor(BigInt(minor), currency as Currency)}`;
}

const day = (iso: string): string => iso.slice(0, 10);

type Convert = Extract<PlanAction, { kind: "convert" }>;

function conversionClause(converts: readonly Convert[]): string {
  const parts = converts.map(
    (c) =>
      `converting ${amount(c.params.sell_currency, c.params.sell_minor)} to ${amount(c.params.buy_currency, c.params.buy_minor)} at ${c.params.rate}`,
  );
  return parts.join(" and ");
}

function fact(action: PlanAction, key: string): string {
  const v = action.reason_facts[key];
  return typeof v === "string" ? v : "0";
}

/** The sentences, one per obligation action, in plan order. Text comes from facts only. */
export function renderExplanation(plan: Plan): string {
  const converts = plan.actions.filter((a): a is Convert => a.kind === "convert");
  const via = (obligationId: string) =>
    converts.filter((c) => c.params.obligation_ids.includes(obligationId));
  const sentences: string[] = [`Plan revision ${plan.revision}.`];
  for (const a of plan.actions) {
    switch (a.kind) {
      case "convert":
        break;
      case "fund": {
        const p = a.params;
        const conv = via(p.obligation_id);
        const money = amount(p.currency, p.amount_minor);
        const fee =
          p.fee_minor === "0"
            ? ""
            : ` The SWIFT fee of ${amount(p.currency, p.fee_minor)} is added.`;
        sentences.push(
          conv.length > 0
            ? `${p.payee}: ${money} is funded by ${conversionClause(conv)}.${fee}`
            : `${p.payee}: ${money} is funded from the ${p.currency} balance.${fee}`,
        );
        break;
      }
      case "payout": {
        const p = a.params;
        const conv = via(p.obligation_id);
        const money = amount(p.currency, p.amount_minor);
        sentences.push(
          `${p.payee}: the held payment is replaced by an alternate payout of ${money}${
            conv.length > 0 ? `, funded by ${conversionClause(conv)}` : ""
          }. It needs your approval.`,
        );
        break;
      }
      case "defer": {
        const p = a.params;
        const reason =
          a.reason_code === "DEFER_BEHIND_UNFUNDED"
            ? `an earlier ${p.currency} obligation is not funded`
            : `${amount(p.currency, fact(a, "spendable_minor"))} is spendable against ${amount(p.currency, fact(a, "needed_minor"))} needed`;
        sentences.push(
          `${p.payee}: ${amount(p.currency, p.amount_minor)} is deferred from ${day(p.current_due_at)} to ${day(p.proposed_due_at)} because ${reason}.`,
        );
        break;
      }
      case "escalate": {
        const p = a.params;
        const note = p.criticality_unconfirmed
          ? " Its criticality is unconfirmed, so it is treated as most protective."
          : "";
        sentences.push(
          `${p.payee}: ${amount(p.currency, p.amount_minor)} is short by ${amount(p.currency, p.shortfall_minor)} and needs your decision.${note}`,
        );
        break;
      }
    }
  }
  return sentences.join(" ");
}

// ---- verification ---------------------------------------------------------------------------

/** What the plan lets a text say: exact amount strings per currency, plain numbers, currencies, dates. */
export interface PlanFacts {
  readonly amounts: ReadonlySet<string>; // "EUR 4,200.00"
  readonly numbers: ReadonlySet<string>; // "4", "0.8847", "50"
  readonly currencies: ReadonlySet<string>;
  readonly dates: ReadonlySet<string>; // "2026-11-06"
  readonly names: readonly string[]; // payee names, which may contain digits
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T|$)/;
const PLAIN_NUMBER = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function planFacts(plan: Plan): PlanFacts {
  const amounts = new Set<string>();
  const numbers = new Set<string>([String(plan.revision), String(plan.policy.version)]);
  const currencies = new Set<string>();
  const dates = new Set<string>([day(plan.now)]);
  const names = new Set<string>();

  const addAmount = (currency: unknown, minor: string) => {
    if (typeof currency !== "string" || !isCurrency(currency)) return;
    currencies.add(currency);
    amounts.add(amount(currency, minor));
  };
  const addPlain = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) numbers.add(String(value));
    else if (typeof value === "string") {
      if (ISO_DATE.test(value)) dates.add(day(value));
      else if (PLAIN_NUMBER.test(value)) numbers.add(value);
      else if (isCurrency(value)) currencies.add(value);
    }
  };

  for (const a of plan.actions) {
    const bag: Record<string, unknown> = { ...a.params, ...a.reason_facts };
    // The currency each minor-unit key is in. Obligation actions are in one currency; a conversion's
    // sell side and buy side differ (the SWIFT fee it covers is a buy-side amount).
    const currencyOf = (key: string): unknown => {
      if (a.kind !== "convert") return (a.params as { currency: string }).currency;
      return key === "buy_minor" || key === "swift_fee_included_minor"
        ? a.params.buy_currency
        : a.params.sell_currency;
    };
    for (const [key, value] of Object.entries(bag)) {
      if (key.endsWith("_minor") && typeof value === "string" && /^-?\d+$/.test(value)) {
        addAmount(currencyOf(key), value);
      } else {
        addPlain(value);
        if (key === "payee" && typeof value === "string") names.add(value);
      }
    }
    if (a.kind === "convert") {
      currencies.add(a.params.sell_currency);
      currencies.add(a.params.buy_currency);
    } else {
      currencies.add((a.params as { currency: string }).currency);
    }
  }
  return {
    amounts,
    numbers,
    currencies,
    dates,
    names: [...names].sort((x, y) => y.length - x.length),
  };
}

export interface Claims {
  readonly amounts: string[];
  readonly numbers: string[];
  readonly currencies: string[];
  readonly dates: string[];
}

const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const AMOUNT_RE = /\b([A-Z]{3}) (-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/g;
const CURRENCY_RE = /\b[A-Z]{3}\b/g;
const NUMBER_RE = /-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;

/** Every date, amount, bare currency and number the text states. Payee names are set aside first. */
export function extractClaims(text: string, names: readonly string[] = []): Claims {
  let rest = text;
  for (const name of names) rest = rest.split(name).join("§");
  const claims: Claims = { amounts: [], numbers: [], currencies: [], dates: [] };
  rest = rest.replace(DATE_RE, (m) => {
    claims.dates.push(m);
    return "§";
  });
  rest = rest.replace(AMOUNT_RE, (m, cur: string, num: string) => {
    if (!isCurrency(cur)) return m;
    claims.amounts.push(`${cur} ${num}`);
    return "§";
  });
  rest = rest.replace(CURRENCY_RE, (m) => {
    if (isCurrency(m)) claims.currencies.push(m);
    return "§";
  });
  for (const m of rest.match(NUMBER_RE) ?? []) claims.numbers.push(m);
  return claims;
}

export type ExplanationCheck = { ok: true } | { ok: false; problems: string[] };

/** Ok only when every claim in `text` is a fact of `plan`. */
export function verifyExplanation(text: string, plan: Plan): ExplanationCheck {
  const facts = planFacts(plan);
  const claims = extractClaims(text, facts.names);
  const problems: string[] = [];
  for (const a of claims.amounts) if (!facts.amounts.has(a)) problems.push(`amount ${a}`);
  for (const d of claims.dates) if (!facts.dates.has(d)) problems.push(`date ${d}`);
  for (const c of claims.currencies) if (!facts.currencies.has(c)) problems.push(`currency ${c}`);
  for (const n of claims.numbers) if (!facts.numbers.has(n)) problems.push(`number ${n}`);
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
