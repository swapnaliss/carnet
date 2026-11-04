// FX: quote, conversion create, conversion retrieve. FX calls never carry `x-api-version` (CLAUDE.md;
// the M0-03 fixtures were recorded without it). The conversion id is `conversion_id`.
// Quotes came back `MULTI_USE` in the sandbox (BL-01, M0-03): Carnet enforces one use per quote in
// its own state (M3-03); the adapter does not rely on Airwallex rejecting a reused quote.
import { z } from "zod";
import { authed } from "./auth";
import { AirwallexApiError } from "./http";
import {
  type Ctx,
  Currency,
  encodeId,
  type MajorAmount,
  toWireAmount,
  WireAmount,
  WireRate,
} from "./wire";

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
  buyCurrency: string;
  sellCurrency: string;
  buyAmount: MajorAmount;
  sellAmount: MajorAmount;
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
  buyCurrency: string;
  sellCurrency: string;
  buyAmount: MajorAmount;
  sellAmount: MajorAmount;
  clientRate: string;
  currencyPair: string | null;
  conversionDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export const QuoteWire = z
  .looseObject({
    quote_id: z.string(),
    buy_currency: Currency,
    sell_currency: Currency,
    buy_amount: WireAmount,
    sell_amount: WireAmount,
    client_rate: WireRate,
    awx_rate: WireRate.nullish(),
    currency_pair: z.string().nullish(),
    validity: z.string().nullish(),
    usage: z.string().nullish(),
    valid_from_at: z.string().nullish(),
    valid_to_at: z.string().nullish(),
  })
  .transform(
    (w): Quote => ({
      quoteId: w.quote_id,
      buyCurrency: w.buy_currency,
      sellCurrency: w.sell_currency,
      buyAmount: w.buy_amount,
      sellAmount: w.sell_amount,
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
    buy_currency: Currency,
    sell_currency: Currency,
    buy_amount: WireAmount,
    sell_amount: WireAmount,
    client_rate: WireRate,
    currency_pair: z.string().nullish(),
    conversion_date: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  })
  .transform(
    (w): Conversion => ({
      conversionId: w.conversion_id,
      requestId: w.request_id ?? null,
      status: w.status,
      buyCurrency: w.buy_currency,
      sellCurrency: w.sell_currency,
      buyAmount: w.buy_amount,
      sellAmount: w.sell_amount,
      clientRate: w.client_rate,
      currencyPair: w.currency_pair ?? null,
      conversionDate: w.conversion_date ?? null,
      createdAt: w.created_at ?? null,
      updatedAt: w.updated_at ?? null,
    }),
  );

type OneAmount =
  | { sellAmount: MajorAmount; buyAmount?: never }
  | { buyAmount: MajorAmount; sellAmount?: never };

export type CreateQuoteInput = {
  buyCurrency: string;
  sellCurrency: string;
  validity: QuoteValidity;
} & OneAmount;

export type CreateConversionInput = {
  requestId: string;
  buyCurrency: string;
  sellCurrency: string;
  reason: string;
  quoteId?: string;
} & OneAmount;

function amountFields(input: OneAmount): Record<string, number> {
  return input.sellAmount !== undefined
    ? { sell_amount: toWireAmount(input.sellAmount, "sellAmount") }
    : { buy_amount: toWireAmount(input.buyAmount, "buyAmount") };
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
    retryable: true, // a quote creates no money movement
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
