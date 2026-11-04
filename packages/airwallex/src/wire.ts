// Shared wire helpers. Airwallex amounts are JSON numbers in major units (`100` is one hundred
// dollars). Inbound, the exact digits (see json.ts) go through the domain's `parseMajor` into integer
// minor units: no float arithmetic. Outbound, a domain `Money` becomes a JSON number only when that
// number reproduces the same minor units exactly; otherwise the call is refused.
import {
  type Currency,
  CurrencySchema,
  formatMajor,
  type Money,
  MoneyError,
  parseMajor,
} from "@carnet/domain";
import { z } from "zod";
import type { TokenCache } from "./auth";
import { AirwallexInputError, type HttpClient } from "./http";
import { WireNumber } from "./json";

export interface Ctx {
  http: HttpClient;
  tokens: TokenCache;
}

export { CurrencySchema };

const PLAIN_DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** Plain number (tests parse fixtures with JSON.parse) -> its shortest decimal text, if exact-looking. */
function plainNumberText(n: number): string | undefined {
  if (!Number.isFinite(n)) return undefined;
  const s = Object.is(n, -0) ? "0" : String(n);
  return PLAIN_DECIMAL.test(s) ? s : undefined;
}

/**
 * A wire number as decimal text: the exact source digits when parsed by the client, or the
 * shortest round-trip text of a plain number. Exponent forms ("1e2") are rejected, not guessed.
 */
export const WireDecimal = z
  .union([z.instanceof(WireNumber), z.number(), z.string()])
  .transform((v, ctx): string => {
    const text =
      v instanceof WireNumber ? v.source : typeof v === "number" ? plainNumberText(v) : v;
    if (text === undefined || !PLAIN_DECIMAL.test(text)) {
      ctx.addIssue({ code: "custom", message: `not a plain decimal: ${String(text ?? v)}` });
      return z.NEVER;
    }
    return text;
  });

/** A wire integer (sizes, epoch seconds). */
export const WireInt = z
  .union([z.instanceof(WireNumber), z.number()])
  .transform((v) => (v instanceof WireNumber ? v.toNumber() : v))
  .pipe(z.number().int());

/** Major-unit decimal text + currency -> domain Money, or a schema issue at `path`. */
export function toMoney(
  amount: string | null | undefined,
  currency: Currency | null | undefined,
  ctx: z.RefinementCtx,
  path: string,
): Money | null {
  if (amount === null || amount === undefined) return null;
  if (!currency) {
    ctx.addIssue({ code: "custom", path: [path], message: "amount without a currency" });
    return null;
  }
  try {
    return parseMajor(amount, currency);
  } catch (err) {
    const message = err instanceof MoneyError ? err.message : "invalid amount";
    ctx.addIssue({ code: "custom", path: [path], message });
    return null;
  }
}

/** Money -> the JSON number Airwallex expects, refused unless the number is exact. */
export function toWireAmount(amount: Money, field: string, expectCurrency?: Currency): number {
  if (expectCurrency && amount.currency !== expectCurrency) {
    throw new AirwallexInputError(`${field} is ${amount.currency}, expected ${expectCurrency}`);
  }
  if (amount.minor <= 0n) throw new AirwallexInputError(`${field} must be positive`);
  const n = Number(formatMajor(amount));
  const text = plainNumberText(n);
  let back: Money | undefined;
  try {
    back = text === undefined ? undefined : parseMajor(text, amount.currency);
  } catch {
    back = undefined;
  }
  if (!back || back.minor !== amount.minor) {
    throw new AirwallexInputError(`${field} cannot be sent as an exact JSON number`);
  }
  return n;
}

export function encodeId(id: string): string {
  if (id === "" || /[/?#]/.test(id)) throw new AirwallexInputError(`invalid id "${id}"`);
  return encodeURIComponent(id);
}
