// The auto-FX policy (M3-03, ADR 0011): the only thing that lets Carnet move money without a person's
// approval, and only for a currency conversion. A policy is versioned and append-only (a change is a
// new version); its canonical-JSON SHA-256 `hash` is stored with every AutoApproval so a later reader
// can tell exactly which rules allowed it. Pure: no clock, no I/O.
import { z } from "zod";
import { type Currency, isCurrency } from "../money";
import { canonicalJson, sha256Hex } from "../planner/sha256";

const currencySchema = z.custom<Currency>(
  (v) => typeof v === "string" && isCurrency(v),
  "unsupported currency",
);
const minorString = z.string().regex(/^\d+$/, "minor units as a decimal string");
const perCurrency = z.array(z.object({ currency: currencySchema, minor: minorString }));

/** What a policy says (everything the hash covers). Amounts are minor units as decimal strings. */
export const PolicyContentSchema = z
  .object({
    /** Balance that must remain in each currency after a conversion. */
    reserveFloor: perCurrency,
    /** Largest sell amount of one auto-approved conversion, per sell currency. */
    perActionLimit: perCurrency,
    /** Cumulative auto-approved sell amount per business day and sell currency. */
    dailyCap: perCurrency,
    /** The fresh quote's rate may differ from the approved indicative rate by at most this. */
    slippageBps: z.number().int().min(0).max(10_000),
    /** A quote older than this (seconds since `valid_from_at`) is not used. */
    quoteFreshnessSeconds: z.number().int().min(1).max(86_400),
  })
  .superRefine((v, ctx) => {
    for (const key of ["reserveFloor", "perActionLimit", "dailyCap"] as const) {
      const seen = new Set<string>();
      for (const row of v[key]) {
        if (seen.has(row.currency)) {
          ctx.addIssue({ code: "custom", message: `${key}: duplicate ${row.currency}` });
        }
        seen.add(row.currency);
      }
    }
  });
export type PolicyContent = z.output<typeof PolicyContentSchema>;
export type PolicyContentInput = z.input<typeof PolicyContentSchema>;

export interface Policy extends PolicyContent {
  readonly version: number;
  /** SHA-256 (lower-case hex) of the canonical JSON of the content (`policyHash`). */
  readonly hash: string;
}

type Row = { currency: Currency; minor: string };
const byCurrency = (a: Row, b: Row): number =>
  a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0;

/** The content in its canonical form: validated, rows sorted by currency. */
export function normalizePolicyContent(raw: PolicyContentInput): PolicyContent {
  const v = PolicyContentSchema.parse(raw);
  return {
    reserveFloor: [...v.reserveFloor].sort(byCurrency),
    perActionLimit: [...v.perActionLimit].sort(byCurrency),
    dailyCap: [...v.dailyCap].sort(byCurrency),
    slippageBps: v.slippageBps,
    quoteFreshnessSeconds: v.quoteFreshnessSeconds,
  };
}

/** The hash of a policy's content: equal content, equal hash; any edit changes it. */
export function policyHash(content: PolicyContentInput): string {
  return sha256Hex(canonicalJson(normalizePolicyContent(content)));
}

/** Builds version `version` of a policy from its content. */
export function makePolicy(version: number, raw: PolicyContentInput): Policy {
  if (!Number.isInteger(version) || version < 1) throw new Error("policy version must be >= 1");
  const content = normalizePolicyContent(raw);
  return { version, ...content, hash: policyHash(content) };
}

/** The planner's view of a policy: the per-currency limit up to which a conversion may be auto. */
export function plannerPolicy(policy: Policy): {
  version: number;
  hash: string;
  autoConvertLimits: { currency: Currency; minor: bigint }[];
} {
  return {
    version: policy.version,
    hash: policy.hash,
    autoConvertLimits: policy.perActionLimit.map((r) => ({
      currency: r.currency,
      minor: BigInt(r.minor),
    })),
  };
}

/** The amount a per-currency list holds for `currency`, or null when it has no row. */
export function minorOf(rows: readonly Row[], currency: Currency): bigint | null {
  const row = rows.find((r) => r.currency === currency);
  return row === undefined ? null : BigInt(row.minor);
}
