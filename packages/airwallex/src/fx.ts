// FX: quote, conversion create, conversion retrieve. FX calls never carry `x-api-version` (CLAUDE.md;
// the M0-03 fixtures were recorded without it). The conversion id is `conversion_id`.
// Quotes came back `MULTI_USE` in the sandbox (BL-01, M0-03): Carnet enforces one use per quote in
// its own state (M3-03); the adapter does not rely on Airwallex rejecting a reused quote.
// Amounts are domain Money; rates stay exact decimal strings (they are not money).
import type { Currency, Money, RequestId } from "@carnet/domain";
import { z } from "zod";
import { authed } from "./auth";
import { AirwallexApiError } from "./http";
import { type Ctx, CurrencySchema, encodeId, toMoney, toWireAmount, WireDecimal } from "./wire";

export const QUOTE_VALIDITIES = [
  "MIN_1",
  "MIN_15",
  "MIN_30",
  "HR_1",
  "HR_4",
  "HR_8",
  "HR_24",
] as const;
export type QuoteValidity = (typeof QUOTE_VALIDITIES)[number];

export interface Quote {
  quoteId: string;
  buyCurrency: Currency;
  sellCurrency: Currency;
  buyAmount: Money | null;
  sellAmount: Money | null;
  clientRate: string;
  awxRate: string | null;
  currencyPair: string | null;
  validity: string | null;
  usage: string | null;
  validFromAt: string | null;
  validToAt: string | null;
}

export interface Conversion {
  conversionId: string;
  requestId: string | null;
  status: string;
  buyCurrency: Currency;
  sellCurrency: Currency;
  buyAmount: Money | null;
  sellAmount: Money | null;
  clientRate: string;
  currencyPair: string | null;
  conversionDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const QuoteWire = z
  .looseObject({
    quote_id: z.string(),
    buy_currency: CurrencySchema,
    sell_currency: CurrencySchema,
    buy_amount: WireDecimal,
    sell_amount: WireDecimal,
    client_rate: WireDecimal,
    awx_rate: WireDecimal.nullish(),
    currency_pair: z.string().nullish(),
    validity: z.string().nullish(),
    usage: z.string().nullish(),
    valid_from_at: z.string().nullish(),
    valid_to_at: z.string().nullish(),
  })
  .transform(
    (w, ctx): Quote => ({
      quoteId: w.quote_id,
      buyCurrency: w.buy_currency,
      sellCurrency: w.sell_currency,
      buyAmount: toMoney(w.buy_amount, w.buy_currency, ctx, "buy_amount"),
      sellAmount: toMoney(w.sell_amount, w.sell_currency, ctx, "sell_amount"),
      clientRate: w.client_rate,
      awxRate: w.awx_rate ?? null,
      currencyPair: w.currency_pair ?? null,
      validity: w.validity ?? null,
      usage: w.usage ?? null,
      validFromAt: w.valid_from_at ?? null,
      validToAt: w.valid_to_at ?? null,
    }),
  );

export const ConversionWire = z
  .looseObject({
    conversion_id: z.string(),
    request_id: z.string().nullish(),
    status: z.string(),
    buy_currency: CurrencySchema,
    sell_currency: CurrencySchema,
    buy_amount: WireDecimal,
    sell_amount: WireDecimal,
    client_rate: WireDecimal,
    currency_pair: z.string().nullish(),
    conversion_date: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .transform(
    (w, ctx): Conversion => ({
      conversionId: w.conversion_id,
      requestId: w.request_id ?? null,
      status: w.status,
      buyCurrency: w.buy_currency,
      sellCurrency: w.sell_currency,
      buyAmount: toMoney(w.buy_amount, w.buy_currency, ctx, "buy_amount"),
      sellAmount: toMoney(w.sell_amount, w.sell_currency, ctx, "sell_amount"),
      clientRate: w.client_rate,
      currencyPair: w.currency_pair ?? null,
      conversionDate: w.conversion_date ?? null,
      createdAt: w.created_at ?? null,
      updatedAt: w.updated_at ?? null,
    }),
  );

/** Exactly one side fixed: the amount sold (in sellCurrency) or bought (in buyCurrency). */
type OneAmount =
  | { sellAmount: Money; buyAmount?: never }
  | { buyAmount: Money; sellAmount?: never };

export type CreateQuoteInput = {
  buyCurrency: Currency;
  sellCurrency: Currency;
  validity: QuoteValidity;
} & OneAmount;

export type CreateConversionInput = {
  requestId: RequestId;
  buyCurrency: Currency;
  sellCurrency: Currency;
  reason: string;
  quoteId?: string;
} & OneAmount;

function amountFields(
  input: OneAmount & { buyCurrency: Currency; sellCurrency: Currency },
): Record<string, number> {
  return input.sellAmount !== undefined
    ? { sell_amount: toWireAmount(input.sellAmount, "sellAmount", input.sellCurrency) }
    : { buy_amount: toWireAmount(input.buyAmount, "buyAmount", input.buyCurrency) };
}

export function quoteCreateBody(input: CreateQuoteInput): Record<string, unknown> {
  return {
    buy_currency: input.buyCurrency,
    sell_currency: input.sellCurrency,
    ...amountFields(input),
    validity: input.validity,
  };
}

export function conversionCreateBody(input: CreateConversionInput): Record<string, unknown> {
  const body: Record<string, unknown> = { request_id: input.requestId };
  if (input.quoteId) body.quote_id = input.quoteId;
  return {
    ...body,
    buy_currency: input.buyCurrency,
    sell_currency: input.sellCurrency,
    ...amountFields(input),
    reason: input.reason,
    term_agreement: true,
  };
}

export async function createQuote(ctx: Ctx, input: CreateQuoteInput): Promise<Quote> {
  return authed(ctx.http, ctx.tokens, {
    method: "POST",
    path: "/api/v1/fx/quotes/create",
    json: quoteCreateBody(input),
    schema: QuoteWire,
    retryable: true, // a quote moves no money
    omitApiVersion: true,
  });
}

export async function getConversion(ctx: Ctx, conversionId: string): Promise<Conversion> {
  return authed(ctx.http, ctx.tokens, {
    method: "GET",
    path: `/api/v1/fx/conversions/${encodeId(conversionId)}`,
    schema: ConversionWire,
    retryable: true,
    omitApiVersion: true,
  });
}

/**
 * Creates a conversion with a caller-persisted `requestId`. If Airwallex answers
 * `duplicate_request_id` with an id in `details.id` (the shape seen for transfers; **unverified** for
 * conversions), the existing conversion is fetched instead.
 */
export async function createConversion(
  ctx: Ctx,
  input: CreateConversionInput,
): Promise<Conversion> {
  try {
    return await authed(ctx.http, ctx.tokens, {
      method: "POST",
      path: "/api/v1/fx/conversions/create",
      json: conversionCreateBody(input),
      schema: ConversionWire,
      retryable: true,
      omitApiVersion: true,
    });
  } catch (err) {
    if (err instanceof AirwallexApiError && err.code === "duplicate_request_id") {
      const d = err.details;
      if (d && typeof d === "object" && "id" in d && typeof d.id === "string") {
        return getConversion(ctx, d.id);
      }
    }
    throw err;
  }
}

const ConversionList = z.looseObject({
  items: z.array(ConversionWire),
  has_more: z.boolean().nullish(),
});

export interface ListConversionsInput {
  requestId?: string;
  pageSize?: number;
}

export async function listConversions(
  ctx: Ctx,
  input: ListConversionsInput = {},
): Promise<{ items: Conversion[]; hasMore: boolean }> {
  const res = await authed(ctx.http, ctx.tokens, {
    method: "GET",
    path: "/api/v1/fx/conversions",
    query: { request_id: input.requestId, page_size: input.pageSize },
    schema: ConversionList,
    retryable: true,
    omitApiVersion: true,
  });
  return { items: res.items, hasMore: res.has_more ?? false };
}

/**
 * The lookup half of ADR 0007 for conversions: the conversion created with `requestId`, or null.
 * The `request_id` list filter is UNVERIFIED (the M0-03 recording lists without it), so the result is
 * also filtered here: a server that ignores the filter cannot return a stranger. Absence is not proof
 * that nothing was created (the list is one page); the caller leaves the attempt UNKNOWN.
 */
export async function findConversionByRequestId(
  ctx: Ctx,
  requestId: string,
): Promise<Conversion | null> {
  const { items } = await listConversions(ctx, { requestId, pageSize: 100 });
  return items.find((c) => c.requestId === requestId) ?? null;
}

// ---- Indicative rate (planner input, M3) --------------------------------------------------------

export interface RateDetail {
  /** `AWX` (the market rate) or `CLIENT` (what the account would get). */
  level: string;
  /** Exact decimal text, for the pair as Airwallex quotes it (not necessarily buy per sell). */
  rate: string;
  buyAmount: string;
  sellAmount: string;
}

export interface CurrentRate {
  buyCurrency: Currency;
  sellCurrency: Currency;
  currencyPair: string | null;
  createdAt: string | null;
  details: RateDetail[];
}

const CurrentRateWire = z
  .looseObject({
    buy_currency: CurrencySchema,
    sell_currency: CurrencySchema,
    currency_pair: z.string().nullish(),
    created_at: z.string().nullish(),
    rate_details: z.array(
      z.looseObject({
        level: z.string(),
        rate: WireDecimal,
        buy_amount: WireDecimal,
        sell_amount: WireDecimal,
      }),
    ),
  })
  .transform(
    (w): CurrentRate => ({
      buyCurrency: w.buy_currency,
      sellCurrency: w.sell_currency,
      currencyPair: w.currency_pair ?? null,
      createdAt: w.created_at ?? null,
      details: w.rate_details.map((d) => ({
        level: d.level,
        rate: d.rate,
        buyAmount: d.buy_amount,
        sellAmount: d.sell_amount,
      })),
    }),
  );

/**
 * `GET /fx/rates/current` (fixture `fx-current-rate`): an indicative rate, not a quote. It moves no
 * money and cannot be converted at. No `x-api-version`, like every FX call.
 */
export async function getCurrentRate(
  ctx: Ctx,
  input: { buyCurrency: Currency; sellCurrency: Currency; sellAmount: Money },
): Promise<CurrentRate> {
  return authed(ctx.http, ctx.tokens, {
    method: "GET",
    path: "/api/v1/fx/rates/current",
    query: {
      buy_currency: input.buyCurrency,
      sell_currency: input.sellCurrency,
      sell_amount: toWireAmount(input.sellAmount, "sellAmount", input.sellCurrency),
    },
    schema: CurrentRateWire,
    retryable: true,
    omitApiVersion: true,
  });
}
