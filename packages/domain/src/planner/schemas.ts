// Planner inputs and outputs (M3-02). Inputs are zod-validated and normalised (sorted, minor units as
// bigint, times as canonical ISO strings) so the same facts in any order give the same hash. The plan
// is JSON-native: every minor-unit amount is a decimal string, so it round-trips through JSON and
// through jsonb unchanged.
import { z } from "zod";
import { type Currency, isCurrency } from "../money";

const currencySchema = z.custom<Currency>(
  (v) => typeof v === "string" && isCurrency(v),
  "unsupported currency",
);

/** Minor units in: a bigint, a safe integer or a decimal string (as the database or JSON gives it). */
const minorSchema = z
  .union([z.bigint(), z.number().int(), z.string().regex(/^-?\d+$/)])
  .transform((v) => BigInt(v));
const nonNegativeMinor = minorSchema.refine((v) => v >= 0n, "must not be negative");
const positiveMinor = minorSchema.refine((v) => v > 0n, "must be positive");

const instantSchema = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "not a date-time")
  .transform((s) => new Date(s).toISOString());

const idSchema = z.string().min(1).max(200);

export const CriticalitySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal("UNCONFIRMED"),
]);
export type Criticality = z.infer<typeof CriticalitySchema>;

export const PAYOUT_METHODS = ["SWIFT", "LOCAL"] as const;

const DECIMAL_RATE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueBy<T>(rows: readonly T[], key: (row: T) => string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const k = key(row);
    if (seen.has(k)) ctx.addIssue({ code: "custom", message: `duplicate row: ${k}` });
    seen.add(k);
  }
}

const balanceSchema = z.object({
  businessId: idSchema,
  currency: currencySchema,
  /** `available_amount` as Airwallex reports it, in minor units. */
  availableMinor: minorSchema,
});

const heldSchema = z.object({
  businessId: idSchema,
  paymentId: idSchema,
  /** The funds a held transfer ties up are in its source currency. */
  currency: currencySchema,
  amountMinor: positiveMinor,
});

const obligationSchema = z.object({
  businessId: idSchema,
  id: idSchema,
  payee: z.string().min(1).max(300),
  amountMinor: positiveMinor,
  currency: currencySchema,
  dueAt: instantSchema,
  criticality: CriticalitySchema,
  paymentId: idSchema.nullable(),
  payoutMethod: z.enum(PAYOUT_METHODS),
});

const floorSchema = z.object({
  businessId: idSchema,
  currency: currencySchema,
  minor: nonNegativeMinor,
});

const feeSchema = z.object({ currency: currencySchema, minor: nonNegativeMinor });

const fxRateSchema = z.object({
  sell: currencySchema,
  buy: currencySchema,
  /** Indicative: major units of `buy` per one major unit of `sell`, as a decimal string. */
  rate: z
    .string()
    .regex(DECIMAL_RATE)
    .refine((r) => /[1-9]/.test(r), "rate must be positive"),
  asOf: instantSchema,
});

/** The flat fees and the planner's rules. Loaded from config/fees.json; never constants in code. */
export const PlannerConfigSchema = z.object({
  /** Flat SWIFT fee per payout, per currency (EUR 13.41 in the sandbox fixture, M0-03). */
  swiftPayoutFee: z.array(feeSchema),
  /** FX spread assumption: the worst-case rate is the indicative rate less this many bps. */
  fxSpreadBps: z.number().int().min(0).max(9999),
  /**
   * True when Airwallex's available balance already excludes a held transfer's funds (M0-04 check 8:
   * the balance is debited at creation). False: the planner subtracts held funds itself.
   */
  heldFundsVisibleInBalances: z.boolean(),
  /** Days a due date may slip, by confirmed criticality 2 and 3. Criticality 1 never slips. */
  deferGraceDays: z.object({ "2": z.number().int().min(0), "3": z.number().int().min(0) }),
});

const policySchema = z.object({
  version: z.number().int().min(0),
  hash: z.string().min(1).max(200),
  /** A conversion is marked eligible-for-auto only up to this sell amount; M3-03 makes the call. */
  autoConvertLimits: z.array(feeSchema),
});

export const PlanInputsSchema = z
  .object({
    businessId: idSchema,
    now: instantSchema,
    balances: z.array(balanceSchema),
    held: z.array(heldSchema),
    obligations: z.array(obligationSchema),
    reserveFloor: z.array(floorSchema),
    config: PlannerConfigSchema,
    fxRates: z.array(fxRateSchema),
    policy: policySchema,
  })
  .superRefine((v, ctx) => {
    uniqueBy(v.balances, (r) => `${r.businessId}/${r.currency}`, ctx);
    uniqueBy(v.held, (r) => `${r.businessId}/${r.paymentId}`, ctx);
    uniqueBy(v.obligations, (r) => `${r.businessId}/${r.id}`, ctx);
    uniqueBy(v.reserveFloor, (r) => `${r.businessId}/${r.currency}`, ctx);
    uniqueBy(v.config.swiftPayoutFee, (r) => r.currency, ctx);
    uniqueBy(v.policy.autoConvertLimits, (r) => r.currency, ctx);
    uniqueBy(v.fxRates, (r) => `${r.sell}>${r.buy}`, ctx);
    for (const r of v.fxRates) {
      if (r.sell === r.buy) ctx.addIssue({ code: "custom", message: "rate between one currency" });
    }
  })
  .transform((v) => ({
    ...v,
    balances: [...v.balances].sort((a, b) =>
      compareStrings(`${a.businessId}/${a.currency}`, `${b.businessId}/${b.currency}`),
    ),
    held: [...v.held].sort((a, b) =>
      compareStrings(`${a.businessId}/${a.paymentId}`, `${b.businessId}/${b.paymentId}`),
    ),
    obligations: [...v.obligations].sort((a, b) =>
      compareStrings(`${a.businessId}/${a.id}`, `${b.businessId}/${b.id}`),
    ),
    reserveFloor: [...v.reserveFloor].sort((a, b) =>
      compareStrings(`${a.businessId}/${a.currency}`, `${b.businessId}/${b.currency}`),
    ),
    fxRates: [...v.fxRates].sort((a, b) =>
      compareStrings(`${a.sell}>${a.buy}`, `${b.sell}>${b.buy}`),
    ),
    config: {
      ...v.config,
      swiftPayoutFee: [...v.config.swiftPayoutFee].sort((a, b) =>
        compareStrings(a.currency, b.currency),
      ),
    },
    policy: {
      ...v.policy,
      autoConvertLimits: [...v.policy.autoConvertLimits].sort((a, b) =>
        compareStrings(a.currency, b.currency),
      ),
    },
  }));

/** What a caller may pass: bigint, integer or decimal-string minor units; any order. */
export type PlanInputsInput = z.input<typeof PlanInputsSchema>;
/** The validated, normalised inputs the planner works on. */
export type PlanInputs = z.output<typeof PlanInputsSchema>;
export type PlannerConfig = z.output<typeof PlannerConfigSchema>;

// ---- Output ---------------------------------------------------------------------------------

const minorString = z.string().regex(/^-?\d+$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const REASON_CODES = [
  "FUNDED_FROM_BALANCE",
  "FUNDED_AFTER_CONVERSION",
  "PAYOUT_ALTERNATE_FOR_HELD",
  "CONVERT_SHORTFALL",
  "DEFER_SHORT_OF_CASH",
  "DEFER_BEHIND_UNFUNDED",
  "ESCALATE_CRITICAL_SHORT",
  "ESCALATE_UNCONFIRMED_SHORT",
  "ESCALATE_NO_DEFERRAL_WINDOW",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** The numbers a decision used. Minor-unit amounts are decimal strings. */
export const ReasonFactsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type ReasonFacts = z.infer<typeof ReasonFactsSchema>;

const criticalityLabel = z.enum(["1", "2", "3", "UNCONFIRMED"]);

const obligationParams = {
  obligation_id: idSchema,
  payee: z.string(),
  currency: currencySchema,
  amount_minor: minorString,
  criticality: criticalityLabel,
};

const actionBase = {
  seq: z.number().int().min(1),
  reason_code: z.enum(REASON_CODES),
  reason_facts: ReasonFactsSchema,
  needs_approval: z.boolean(),
};

export const FundActionSchema = z.object({
  ...actionBase,
  kind: z.literal("fund"),
  params: z.object({
    ...obligationParams,
    fee_minor: minorString,
    reserved_minor: minorString,
    criticality_unconfirmed: z.boolean(),
  }),
});

export const PayoutActionSchema = z.object({
  ...actionBase,
  kind: z.literal("payout"),
  params: z.object({
    ...obligationParams,
    held_payment_id: idSchema,
    fee_minor: minorString,
    reserved_minor: minorString,
    criticality_unconfirmed: z.boolean(),
  }),
});

export const ConvertActionSchema = z.object({
  ...actionBase,
  kind: z.literal("convert"),
  params: z.object({
    sell_currency: currencySchema,
    buy_currency: currencySchema,
    sell_minor: minorString,
    buy_minor: minorString,
    swift_fee_included_minor: minorString,
    rate: z.string(),
    rate_low: z.string(),
    rate_high: z.string(),
    rate_as_of: z.string(),
    auto_eligible: z.boolean(),
    obligation_ids: z.array(idSchema),
  }),
});

export const DeferActionSchema = z.object({
  ...actionBase,
  kind: z.literal("defer"),
  params: z.object({
    ...obligationParams,
    current_due_at: z.string(),
    proposed_due_at: z.string(),
  }),
});

export const EscalateActionSchema = z.object({
  ...actionBase,
  kind: z.literal("escalate"),
  params: z.object({
    ...obligationParams,
    shortfall_minor: minorString,
    criticality_unconfirmed: z.boolean(),
  }),
});

export const PlanActionSchema = z.discriminatedUnion("kind", [
  FundActionSchema,
  ConvertActionSchema,
  DeferActionSchema,
  EscalateActionSchema,
  PayoutActionSchema,
]);
export type PlanAction = z.infer<typeof PlanActionSchema>;
export type PlanActionKind = PlanAction["kind"];
export const PLAN_ACTION_KINDS = ["fund", "convert", "defer", "escalate", "payout"] as const;

export const PlanSchema = z.object({
  schema_version: z.literal(1),
  business_id: idSchema,
  /** 1 for the first plan of a business; each changed `inputs_hash` adds one. */
  revision: z.number().int().min(1),
  /** SHA-256 over the canonical JSON of all inputs, config and `now` included. */
  inputs_hash: hex64,
  /** SHA-256 over the business, policy and actions: equal for equal decisions. */
  content_hash: hex64,
  now: z.string(),
  policy: z.object({ version: z.number().int(), hash: z.string() }),
  held_funds_visible_in_balances: z.boolean(),
  actions: z.array(PlanActionSchema),
});
export type Plan = z.infer<typeof PlanSchema>;
