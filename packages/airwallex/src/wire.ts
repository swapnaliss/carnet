// Shared wire helpers. Airwallex sends amounts as JSON numbers in major units (`100` is one hundred
// dollars). The adapter hands them on as canonical decimal strings so the domain parses them into
// integer minor units (`parseMajor`, M1-01) without ever doing float arithmetic.
import { z } from "zod";
import type { TokenCache } from "./auth";
import { AirwallexInputError, type HttpClient } from "./http";

export interface Ctx {
  http: HttpClient;
  tokens: TokenCache;
}

/** A major-unit decimal string such as "25", "13.41" or "0.5". */
export type MajorAmount = string;

const DECIMAL = /^\d+(\.\d+)?$/;
const SIGNED_DECIMAL = /^-?\d+(\.\d+)?$/;

/** Finite JSON number -> decimal string without exponent ("13.41", "-2", "0.000001"). */
export function numberToDecimal(n: number): MajorAmount {
  const s = String(n);
  if (SIGNED_DECIMAL.test(s)) return s === "-0" ? "0" : s;
  // exponent form (very small or very large): fixed notation, trailing zeros trimmed
  return n.toFixed(12).replace(/\.?0+$/, "");
}

/** Wire amount (number, or numeric string) -> canonical major-unit decimal string. */
export const WireAmount = z
  .union([z.number().refine(Number.isFinite), z.string().regex(SIGNED_DECIMAL)])
  .transform((v) => (typeof v === "number" ? numberToDecimal(v) : v));

/** Wire rate (number) -> decimal string; rates are not money but must not be rounded either. */
export const WireRate = WireAmount;

/** Validates a caller's major-unit amount and turns it into the JSON number Airwallex expects. */
export function toWireAmount(amount: MajorAmount, field: string): number {
  if (!DECIMAL.test(amount)) {
    throw new AirwallexInputError(`${field} must be a major-unit decimal string, got "${amount}"`);
  }
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new AirwallexInputError(`${field} must be positive`);
  return n;
}

export const Currency = z.string().regex(/^[A-Z]{3}$/);

export function encodeId(id: string): string {
  if (id === "" || /[/?#]/.test(id)) throw new AirwallexInputError(`invalid id "${id}"`);
  return encodeURIComponent(id);
}
