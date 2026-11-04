// Locale formatting for money and dates (ADR 0017). Money arrives as integer minor units (ADR 0002)
// and is formatted from an exact decimal string, never through a JavaScript number, so amounts above
// 2^53 minor units and every currency exponent format without rounding.

/**
 * The shape of the domain `Money` (`packages/domain`, M1-01): integer minor units plus an ISO 4217
 * code. Structural, so the domain type satisfies it without this module importing the domain.
 */
export interface MoneyLike {
  readonly minor: bigint;
  readonly currency: string;
}

export type CurrencyDisplay = "code" | "symbol" | "narrowSymbol";

export interface FormatMoneyOptions {
  /** How the currency is shown. Default `"code"`: cross-border amounts stay unambiguous (US$ vs A$). */
  readonly currencyDisplay?: CurrencyDisplay;
  /** Always show a sign, e.g. for debits and credits in a ledger. Default `"auto"`. */
  readonly signDisplay?: "auto" | "always" | "exceptZero";
}

const CURRENCY_CODE = /^[A-Z]{3}$/;

/** Minor-unit exponent for a currency from the runtime's ISO 4217 data (USD 2, JPY 0, BHD 3). */
export function currencyExponent(currency: string): number {
  if (!CURRENCY_CODE.test(currency)) throw new RangeError(`not an ISO 4217 code: ${currency}`);
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
    .maximumFractionDigits as number;
}

/** `12345n` with exponent 2 becomes `"123.45"`; `-5n` becomes `"-0.05"`; exponent 0 is unchanged. */
export function minorToDecimalString(minor: bigint, exponent: number): `${number}` {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  const body = exponent === 0 ? whole : `${whole}.${fraction}`;
  return `${negative ? "-" : ""}${body}` as `${number}`;
}

/** Format domain money for display in `locale`, exactly (no floating point). */
export function formatMoney(money: MoneyLike, locale: string, options: FormatMoneyOptions = {}) {
  const exponent = currencyExponent(money.currency);
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: money.currency,
    currencyDisplay: options.currencyDisplay ?? "code",
    signDisplay: options.signDisplay ?? "auto",
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  });
  // A decimal string is formatted exactly by Intl.NumberFormat (ECMA-402 "Intl.NumberFormat v3").
  return formatter.format(minorToDecimalString(money.minor, exponent));
}

export interface FormatDateOptions {
  /** Default `"medium"`. */
  readonly dateStyle?: "full" | "long" | "medium" | "short";
  /** Omitted by default (date only). */
  readonly timeStyle?: "full" | "long" | "medium" | "short";
  /** IANA zone. Default `"UTC"`, so server and client render the same text. */
  readonly timeZone?: string;
}

function toDate(value: Date | string): Date {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) throw new RangeError(`invalid date: ${String(value)}`);
  return date;
}

/** Format an instant (a `Date` or an ISO 8601 string) for display in `locale`. */
export function formatDate(value: Date | string, locale: string, options: FormatDateOptions = {}) {
  const { dateStyle = "medium", timeStyle, timeZone = "UTC" } = options;
  return new Intl.DateTimeFormat(locale, {
    dateStyle,
    ...(timeStyle ? { timeStyle } : {}),
    timeZone,
  }).format(toDate(value));
}

const UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 60 * 60],
  ["month", 30 * 24 * 60 * 60],
  ["week", 7 * 24 * 60 * 60],
  ["day", 24 * 60 * 60],
  ["hour", 60 * 60],
  ["minute", 60],
  ["second", 1],
];

/**
 * "3 minutes ago", "in 2 days", "now": the largest whole unit between `value` and `now`, truncated
 * toward zero so a time is never reported as further away than it is.
 */
export function formatRelative(value: Date | string, now: Date | string, locale: string) {
  const seconds = Math.trunc((toDate(value).getTime() - toDate(now).getTime()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === "second") {
      return formatter.format(Math.trunc(seconds / size), unit);
    }
  }
  return formatter.format(0, "second");
}
