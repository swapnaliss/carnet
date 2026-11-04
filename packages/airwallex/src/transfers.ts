// Transfers: create (with request_id), retrieve, list, and lookup by request_id.
// Rules from the M0 spikes (docs/evidence/airwallex-money-path.md):
// - reusing a request_id answers 400 `duplicate_request_id` with the existing id in `details.id`;
//   createTransfer treats that as "already created" and fetches it (BL-01, M0-03);
// - a create that times out is never sent again with a new request_id: the wrapper looks the
//   transfer up by its request_id instead (ADR 0007);
// - `fee_paid_by` is omitted unless the caller sets it: the sandbox answers 400 `fee_unknown` to
//   `PAYER` since 4 Nov 2026 (BL-01, M0-05);
// - a failed transfer may read FAILED or CANCELLED; the reason is in `failure{code,details.type,message}`.
// Statuses, currencies, money and request ids are the domain's (`@carnet/domain`, M1-01).
import {
  type Currency,
  type Money,
  type RequestId,
  TRANSFER_STATUSES,
  type TransferStatus,
} from "@carnet/domain";
import { z } from "zod";
import { authed } from "./auth";
import { AirwallexApiError, AirwallexInputError, AirwallexTimeout } from "./http";
import { type Ctx, CurrencySchema, encodeId, toMoney, toWireAmount, WireDecimal } from "./wire";

export type TransferMethod = "LOCAL" | "SWIFT";

export interface TransferFailure {
  code: string | null;
  type: string | null;
  message: string | null;
}

export interface Transfer {
  id: string;
  requestId: string;
  status: TransferStatus;
  shortReferenceId: string | null;
  beneficiaryId: string;
  transferMethod: string;
  sourceCurrency: Currency;
  sourceAmount: Money | null;
  transferCurrency: Currency;
  transferAmount: Money | null;
  fee: Money | null;
  feePaidBy: string | null;
  /** In the source currency; includes the fee when the payer pays it. */
  amountPayerPays: Money | null;
  /** In the transfer currency. */
  amountBeneficiaryReceives: Money | null;
  reason: string | null;
  reference: string | null;
  fundingStatus: string | null;
  failure: TransferFailure | null;
  createdAt: string;
  updatedAt: string;
}

export const TransferWire = z
  .looseObject({
    id: z.string(),
    request_id: z.string(),
    status: z.enum(TRANSFER_STATUSES),
    short_reference_id: z.string().nullish(),
    beneficiary_id: z.string(),
    transfer_method: z.string(),
    source_currency: CurrencySchema,
    source_amount: WireDecimal.nullish(),
    transfer_currency: CurrencySchema,
    transfer_amount: WireDecimal.nullish(),
    fee_currency: CurrencySchema.nullish(),
    fee_amount: WireDecimal.nullish(),
    fee_paid_by: z.string().nullish(),
    amount_payer_pays: WireDecimal.nullish(),
    amount_beneficiary_receives: WireDecimal.nullish(),
    reason: z.string().nullish(),
    reference: z.string().nullish(),
    funding: z.looseObject({ status: z.string().nullish() }).nullish(),
    failure: z
      .looseObject({
        code: z.string().nullish(),
        message: z.string().nullish(),
        details: z.looseObject({ type: z.string().nullish() }).nullish(),
      })
      .nullish(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform(
    (w, ctx): Transfer => ({
      id: w.id,
      requestId: w.request_id,
      status: w.status,
      shortReferenceId: w.short_reference_id ?? null,
      beneficiaryId: w.beneficiary_id,
      transferMethod: w.transfer_method,
      sourceCurrency: w.source_currency,
      sourceAmount: toMoney(w.source_amount, w.source_currency, ctx, "source_amount"),
      transferCurrency: w.transfer_currency,
      transferAmount: toMoney(w.transfer_amount, w.transfer_currency, ctx, "transfer_amount"),
      fee: toMoney(w.fee_amount, w.fee_currency, ctx, "fee_amount"),
      feePaidBy: w.fee_paid_by ?? null,
      amountPayerPays: toMoney(w.amount_payer_pays, w.source_currency, ctx, "amount_payer_pays"),
      amountBeneficiaryReceives: toMoney(
        w.amount_beneficiary_receives,
        w.transfer_currency,
        ctx,
        "amount_beneficiary_receives",
      ),
      reason: w.reason ?? null,
      reference: w.reference ?? null,
      fundingStatus: w.funding?.status ?? null,
      failure: w.failure
        ? {
            code: w.failure.code ?? null,
            type: w.failure.details?.type ?? null,
            message: w.failure.message ?? null,
          }
        : null,
      createdAt: w.created_at,
      updatedAt: w.updated_at,
    }),
  );

const TransferList = z.looseObject({
  items: z.array(TransferWire),
  page_after: z.string().nullish(),
});

export interface CreateTransferInput {
  /** Minted once per intent and persisted before the call (ADR 0007). */
  requestId: RequestId;
  beneficiaryId: string;
  sourceCurrency: Currency;
  transferCurrency: Currency;
  /** Exactly one of sourceAmount (in sourceCurrency) / transferAmount (in transferCurrency). */
  sourceAmount?: Money;
  transferAmount?: Money;
  transferMethod: TransferMethod;
  reason: string;
  reference: string;
  /** Omitted by default (see header). */
  feePaidBy?: "PAYER" | "BENEFICIARY";
}

export function transferCreateBody(input: CreateTransferInput): Record<string, unknown> {
  if ((input.sourceAmount === undefined) === (input.transferAmount === undefined)) {
    throw new AirwallexInputError(
      "createTransfer needs exactly one of sourceAmount or transferAmount",
    );
  }
  const body: Record<string, unknown> = {
    request_id: input.requestId,
    beneficiary_id: input.beneficiaryId,
    source_currency: input.sourceCurrency,
    transfer_currency: input.transferCurrency,
  };
  if (input.sourceAmount !== undefined)
    body.source_amount = toWireAmount(input.sourceAmount, "sourceAmount", input.sourceCurrency);
  if (input.transferAmount !== undefined)
    body.transfer_amount = toWireAmount(
      input.transferAmount,
      "transferAmount",
      input.transferCurrency,
    );
  body.transfer_method = input.transferMethod;
  body.reason = input.reason;
  body.reference = input.reference;
  if (input.feePaidBy) body.fee_paid_by = input.feePaidBy;
  return body;
}

export async function getTransfer(ctx: Ctx, id: string): Promise<Transfer> {
  return authed(ctx.http, ctx.tokens, {
    method: "GET",
    path: `/api/v1/transfers/${encodeId(id)}`,
    schema: TransferWire,
    retryable: true,
  });
}

export interface ListTransfersInput {
  requestId?: string;
  status?: TransferStatus;
  pageSize?: number;
  pageAfter?: string;
}

export async function listTransfers(
  ctx: Ctx,
  input: ListTransfersInput = {},
): Promise<{ items: Transfer[]; pageAfter: string | null }> {
  const res = await authed(ctx.http, ctx.tokens, {
    method: "GET",
    path: "/api/v1/transfers",
    query: {
      request_id: input.requestId,
      status: input.status,
      page_size: input.pageSize,
      page_after: input.pageAfter,
    },
    schema: TransferList,
    retryable: true,
  });
  return { items: res.items, pageAfter: res.page_after ?? null };
}

/**
 * The lookup half of ADR 0007: the transfer created with `requestId`, or null if none exists.
 * Filters client-side too, so a server that ignored the `request_id` filter cannot return a stranger.
 */
export async function findTransferByRequestId(
  ctx: Ctx,
  requestId: string,
): Promise<Transfer | null> {
  const { items } = await listTransfers(ctx, { requestId, pageSize: 10 });
  return items.find((t) => t.requestId === requestId) ?? null;
}

function duplicateId(err: AirwallexApiError): string | undefined {
  if (err.code !== "duplicate_request_id") return undefined;
  const d = err.details;
  if (d && typeof d === "object" && "id" in d && typeof d.id === "string") return d.id;
  return undefined;
}

/**
 * Creates a transfer. Idempotent per `requestId`:
 * - `duplicate_request_id` -> fetches and returns the existing transfer;
 * - timeout -> looks the transfer up by `requestId` (never a new id); if it is not found the
 *   original AirwallexTimeout is thrown and the attempt stays UNKNOWN for the reconciler.
 */
export async function createTransfer(ctx: Ctx, input: CreateTransferInput): Promise<Transfer> {
  const body = transferCreateBody(input);
  try {
    return await authed(ctx.http, ctx.tokens, {
      method: "POST",
      path: "/api/v1/transfers/create",
      json: body,
      schema: TransferWire,
      retryable: true, // the body carries request_id: a resend is de-duplicated by Airwallex
    });
  } catch (err) {
    if (err instanceof AirwallexApiError) {
      const existing = duplicateId(err);
      if (existing) {
        ctx.http.logger.info(
          { requestId: input.requestId, transferId: existing },
          "transfer exists",
        );
        return getTransfer(ctx, existing);
      }
    }
    if (err instanceof AirwallexTimeout) {
      // a failed lookup leaves the outcome UNKNOWN: surface the original timeout
      const found = await findTransferByRequestId(ctx, input.requestId).catch(() => null);
      if (found) return found;
    }
    throw err;
  }
}
