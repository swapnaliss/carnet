// Quote matching and value parsing for extracted facts (M2-02, ADR 0010). Pure: no I/O.
//
// Code, not the model, decides whether a fact is grounded: the quote must occur verbatim (after
// normalisation) on the claimed page of the PDF text layer, and the value must be derivable from the
// quote. Amounts are compared by parsed minor units and currency, dates by calendar date, never by
// substring.
import { CURRENCY_EXPONENTS, type Currency, isCurrency, parseMajor } from "../money";

// Soft hyphen, zero-width space/joiners, word joiner, BOM.
const INVISIBLE = /\u{ad}|\u{200b}|\u{200c}|\u{200d}|\u{2060}|\u{feff}/gu;
const HYPHEN_BREAK = /(\p{L})-[ \t]*\r?\n[ \t]*(\p{L})/gu;
const DASHES = /[\u{2010}-\u{2015}\u{2212}]/gu;
const SINGLE_QUOTES = /[\u{2018}\u{2019}\u{201a}\u{201b}\u{2032}]/gu;
const DOUBLE_QUOTES = /[\u{201c}\u{201d}\u{201e}\u{201f}\u{2033}]/gu;

/**
 * Normal form for comparing a quote with page text: Unicode NFKC, invisible characters removed, a
 * word split by a hyphen at a line break re-joined, typographic dashes and quotes made plain, all
 * whitespace runs one space, trimmed. Case is kept: a changed capital is a changed quote.
 */
export function normalizeText(input: string): string {
  return input
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(HYPHEN_BREAK, "$1$2")
    .replace(DASHES, "-")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const withoutHyphens = (s: string) => s.replaceAll("-", "");

/** True when `quote` occurs in `pageText`, both normalised. An empty quote never matches. */
export function quoteOccursOnPage(quote: string, pageText: string): boolean {
  const q = normalizeText(quote);
  if (q.length === 0) return false;
  const page = normalizeText(pageText);
  if (page.includes(q)) return true;
  // A word that wraps at a hyphen may be quoted with or without it.
  const qh = withoutHyphens(q);
  return qh.length > 0 && withoutHyphens(page).includes(qh);
}

// ---------------------------------------------------------------------------------------------
// Dates

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function isoDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) {
    return null;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Each pattern yields [y, m, d] from its groups. 05.10.2026 is day.month.year (the European form);
// slash dates are ambiguous and are not read.
const DATE_PATTERNS: readonly {
  re: RegExp;
  pick: (m: RegExpExecArray) => [number, number, number];
}[] = [
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, pick: (m) => [Number(m[1]), Number(m[2]), Number(m[3])] },
  {
    re: /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g,
    pick: (m) => [Number(m[3]), Number(m[2]), Number(m[1])],
  },
  {
    re: /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g,
    pick: (m) => [Number(m[3]), MONTHS[(m[2] ?? "").toLowerCase()] ?? 0, Number(m[1])],
  },
  {
    re: /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g,
    pick: (m) => [Number(m[3]), MONTHS[(m[1] ?? "").toLowerCase()] ?? 0, Number(m[2])],
  },
];

/** Every valid calendar date written in `text`, as ISO `YYYY-MM-DD` (document order, de-duplicated). */
export function findDates(text: string): string[] {
  const found: { at: number; iso: string }[] = [];
  const t = normalizeText(text);
  for (const { re, pick } of DATE_PATTERNS) {
    for (const m of t.matchAll(re)) {
      const [y, mo, d] = pick(m as RegExpExecArray);
      const iso = isoDate(y, mo, d);
      if (iso) found.push({ at: m.index ?? 0, iso });
    }
  }
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((f) => f.iso))];
}

/** The ISO date a whole value string spells, or null (the value must be only a date). */
export function parseDateValue(value: string): string | null {
  const v = normalizeText(value).replace(/[.,;]$/, "");
  for (const { re, pick } of DATE_PATTERNS) {
    const m = new RegExp(`^(?:${re.source})$`).exec(v);
    if (!m) continue;
    const [y, mo, d] = pick(m);
    const iso = isoDate(y, mo, d);
    if (iso) return iso;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Amounts

export interface ParsedAmount {
  readonly minor: bigint;
  readonly currency: Currency;
}

const SYMBOLS: Record<string, Currency> = { "€": "EUR", $: "USD", "£": "GBP" };
const NUMBER = String.raw`\d{1,3}(?:[,. \u{a0}\u{202f}']\d{3})+(?:[.,]\d{1,3})?|\d+(?:[.,]\d{1,3})?`;
const CODE = String.raw`\b[A-Z]{3}\b`;
const SYM = "[€$£]";
const AMOUNT_RE = new RegExp(
  `(?:(${CODE})|(${SYM}))?\\s?(${NUMBER})(?!\\d)\\s?(?:(${CODE})|(${SYM}))?`,
  "gu",
);

/** Decimal string ("4800.00") for an amount token in either English or European notation. */
function decimalOf(token: string, exponent: number): string | null {
  const t = token.replace(/[ \u{a0}\u{202f}']/gu, "");
  const lastDot = t.lastIndexOf(".");
  const lastComma = t.lastIndexOf(",");
  let decimalAt = -1;
  if (lastDot >= 0 && lastComma >= 0) {
    decimalAt = Math.max(lastDot, lastComma);
  } else {
    const sep = lastDot >= 0 ? "." : lastComma >= 0 ? "," : "";
    if (sep) {
      const count = t.split(sep).length - 1;
      const digitsAfter = t.length - t.lastIndexOf(sep) - 1;
      // One separator with exactly three digits after it is a thousands mark, except for a
      // three-decimal currency; several separators are always thousands marks.
      const thousands = count > 1 || (digitsAfter === 3 && exponent !== 3);
      if (!thousands) decimalAt = t.lastIndexOf(sep);
    }
  }
  const whole = (decimalAt >= 0 ? t.slice(0, decimalAt) : t).replace(/[.,]/g, "");
  const fraction = decimalAt >= 0 ? t.slice(decimalAt + 1) : "";
  if (!/^\d+$/.test(whole) || (fraction !== "" && !/^\d+$/.test(fraction))) return null;
  const w = whole.replace(/^0+(?=\d)/, "");
  return fraction ? `${w}.${fraction}` : w;
}

function toAmount(token: string, currency: Currency): ParsedAmount | null {
  const decimal = decimalOf(token, CURRENCY_EXPONENTS[currency]);
  if (decimal === null) return null;
  try {
    const m = parseMajor(decimal, currency);
    return { minor: m.minor, currency };
  } catch {
    return null;
  }
}

/** Amounts written in `text` with a currency code or symbol next to them, in document order. */
export function findAmounts(text: string): ParsedAmount[] {
  const out: ParsedAmount[] = [];
  const t = normalizeText(text);
  for (const m of t.matchAll(AMOUNT_RE)) {
    const code = m[1] ?? m[4];
    const symbol = m[2] ?? m[5];
    const currency = code ?? (symbol ? SYMBOLS[symbol] : undefined);
    if (!currency || !isCurrency(currency)) continue;
    const amount = toAmount(m[3] ?? "", currency);
    if (amount) out.push(amount);
  }
  return out;
}

/** The amount a whole value string spells ("EUR 8,400.00"), or null (exactly one amount, with a currency). */
export function parseAmountValue(value: string): ParsedAmount | null {
  const amounts = findAmounts(value);
  if (amounts.length !== 1) return null;
  const rest = normalizeText(value).replace(AMOUNT_RE, "").trim();
  return rest.length === 0 ? (amounts[0] ?? null) : null;
}

// ---------------------------------------------------------------------------------------------
// Values against quotes

export type FactValueKind = "text" | "date" | "amount";

export type ParsedValue =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "date"; readonly date: string }
  | { readonly type: "amount"; readonly minor: string; readonly currency: Currency };

/** Parses the model's value string by the key's kind. Null when it is not that kind of value. */
export function parseFactValue(kind: FactValueKind, value: string): ParsedValue | null {
  switch (kind) {
    case "text": {
      const text = normalizeText(value);
      return text.length > 0 ? { type: "text", text } : null;
    }
    case "date": {
      const date = parseDateValue(value);
      return date ? { type: "date", date } : null;
    }
    case "amount": {
      const a = parseAmountValue(value);
      return a ? { type: "amount", minor: a.minor.toString(), currency: a.currency } : null;
    }
  }
}

/** True when the parsed value is written in the quote (text contained; date and amount by value). */
export function valueSupportedByQuote(parsed: ParsedValue, quote: string): boolean {
  switch (parsed.type) {
    case "text": {
      const q = normalizeText(quote);
      const v = parsed.text.replace(/[.,;]$/, "");
      return v.length > 0 && (q.includes(v) || withoutHyphens(q).includes(withoutHyphens(v)));
    }
    case "date":
      return findDates(quote).includes(parsed.date);
    case "amount":
      return findAmounts(quote).some(
        (a) => a.minor.toString() === parsed.minor && a.currency === parsed.currency,
      );
  }
}
