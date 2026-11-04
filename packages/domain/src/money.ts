// Money as integer minor units (ADR 0002). Decimal strings exist only at the Airwallex boundary,
// through parseMajor and formatMajor. No floating point anywhere in this module.

/**
 * Minor-unit exponent per ISO 4217 currency: every currency seen in the M0-03 and M0-04 fixtures,
 * plus the ticket's required set. Values follow ISO 4217; Airwallex's own per-currency decimal
 * handling is unverified (no fixture exercises a 0- or 3-decimal currency amount).
 */
export const CURRENCY_EXPONENTS = {
  AED: 2,
  ARS: 2,
  AUD: 2,
  BDT: 2,
  BHD: 3,
  BOB: 2,
  BRL: 2,
  CAD: 2,
  CHF: 2,
  CLP: 0,
  CNY: 2,
  COP: 2,
  CZK: 2,
  DKK: 2,
  EGP: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  HRK: 2,
  HUF: 2,
  IDR: 2,
  ILS: 2,
  INR: 2,
  JPY: 0,
  KRW: 0,
  LKR: 2,
  MAD: 2,
  MXN: 2,
  MYR: 2,
  NOK: 2,
  NPR: 2,
  NZD: 2,
  PEN: 2,
  PHP: 2,
  PKR: 2,
  PLN: 2,
  RON: 2,
  SAR: 2,
  SEK: 2,
  SGD: 2,
  THB: 2,
  TRY: 2,
  USD: 2,
  UYU: 2,
  VND: 0,
  ZAR: 2,
} as const satisfies Record<string, 0 | 2 | 3>;

export type Currency = keyof typeof CURRENCY_EXPONENTS;

export const CURRENCIES = Object.keys(CURRENCY_EXPONENTS) as readonly Currency[];

export interface Money {
  readonly minor: bigint;
  readonly currency: Currency;
}

export class MoneyError extends Error {
  override readonly name = "MoneyError";
}

export class CurrencyMismatchError extends MoneyError {
  constructor(a: Currency, b: Currency) {
    super(`currency mismatch: ${a} and ${b}`);
  }
}

export function isCurrency(value: string): value is Currency {
  return Object.hasOwn(CURRENCY_EXPONENTS, value);
}

export function exponentOf(currency: Currency): number {
  return CURRENCY_EXPONENTS[currency];
}

export function money(minor: bigint, currency: Currency): Money {
  if (!isCurrency(currency)) throw new MoneyError(`unknown currency: ${String(currency)}`);
  return { minor, currency };
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { minor: a.minor + b.minor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return { minor: a.minor - b.minor, currency: a.currency };
}

export function negate(a: Money): Money {
  return { minor: -a.minor, currency: a.currency };
}

/** -1, 0 or 1. Throws on different currencies: amounts in two currencies are not comparable. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

const DECIMAL = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/**
 * Parse an Airwallex major-unit decimal string ("100.50") into minor units. Accepts at most the
 * currency's exponent in decimals ("100", "100.5" and "100.50" are all USD 10050). Rejects
 * non-numeric input, exponents, leading zeros, a leading "+", and every negative-zero form.
 */
export function parseMajor(input: string, currency: Currency): Money {
  if (!isCurrency(currency)) throw new MoneyError(`unknown currency: ${String(currency)}`);
  const m = DECIMAL.exec(input);
  if (!m) throw new MoneyError(`not a decimal amount: ${JSON.stringify(input)}`);
  const [, sign = "", whole = "", fraction = ""] = m;
  const exp = CURRENCY_EXPONENTS[currency];
  if (fraction.length > exp) {
    throw new MoneyError(`${currency} allows ${exp} decimals, got ${JSON.stringify(input)}`);
  }
  const minor = BigInt(whole + fraction.padEnd(exp, "0"));
  if (sign === "-" && minor === 0n) {
    throw new MoneyError(`negative zero is not an amount: ${JSON.stringify(input)}`);
  }
  return { minor: sign === "-" ? -minor : minor, currency };
}

/** Canonical major-unit string: exactly the currency's exponent in decimals ("100.50", "1000"). */
export function formatMajor(value: Money): string {
  const exp = CURRENCY_EXPONENTS[value.currency];
  const negative = value.minor < 0n;
  const digits = (negative ? -value.minor : value.minor).toString().padStart(exp + 1, "0");
  const whole = digits.slice(0, digits.length - exp);
  const fraction = digits.slice(digits.length - exp);
  return `${negative ? "-" : ""}${whole}${exp > 0 ? `.${fraction}` : ""}`;
}

/**
 * Split `total` into `parts` amounts that differ by at most one minor unit and sum exactly to
 * `total`. The remainder goes to the first parts, so the result is deterministic.
 */
export function allocate(total: Money, parts: number): Money[] {
  if (!Number.isSafeInteger(parts) || parts < 1) {
    throw new MoneyError(`parts must be a positive integer, got ${parts}`);
  }
  const n = BigInt(parts);
  const base = total.minor / n; // truncates toward zero
  const remainder = total.minor - base * n; // same sign as total, |remainder| < n
  const step = remainder < 0n ? -1n : 1n;
  const extra = remainder < 0n ? -remainder : remainder;
  return Array.from({ length: parts }, (_, i) => ({
    minor: BigInt(i) < extra ? base + step : base,
    currency: total.currency,
  }));
}
