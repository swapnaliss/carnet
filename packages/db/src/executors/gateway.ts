// The Airwallex calls the executors make (M3-03), as a structural port: `packages/db` takes no
// dependency on `packages/airwallex`, and the real client satisfies it as it is (the worker passes it,
// tests pass the real client wired to the recorded fixtures). Amounts are domain Money (minor units);
// FX calls carry no `x-api-version` (the adapter omits it, docs/evidence/airwallex-money-path.md).
import type { Currency, Money, RequestId } from "@carnet/domain";

export interface GatewayBalance {
  currency: Currency;
  available: Money;
}

export interface GatewayQuote {
  quoteId: string;
  buyAmount: Money | null;
  sellAmount: Money | null;
  /** `valid_from_at`, an ISO instant. */
  validFromAt: string | null;
}

export interface GatewayConversion {
  conversionId: string;
  requestId: string | null;
  status: string;
  buyAmount: Money | null;
  sellAmount: Money | null;
}

export interface GatewayBeneficiary {
  id: string;
  name: string | null;
  bankCountryCode: string;
  accountCurrency: Currency;
  accountHint: string | null;
}

export interface GatewayTransfer {
  id: string;
  status: string;
}

export interface QuoteRequest {
  buyCurrency: Currency;
  sellCurrency: Currency;
  sellAmount: Money;
  validity: "MIN_1" | "MIN_15" | "MIN_30" | "HR_1" | "HR_4" | "HR_8" | "HR_24";
}

export interface ConversionRequest {
  requestId: RequestId;
  buyCurrency: Currency;
  sellCurrency: Currency;
  sellAmount: Money;
  reason: string;
  quoteId?: string;
}

export interface TransferRequest {
  requestId: RequestId;
  beneficiaryId: string;
  sourceCurrency: Currency;
  transferCurrency: Currency;
  sourceAmount: Money;
  transferMethod: "LOCAL" | "SWIFT";
  reason: string;
  reference: string;
  feePaidBy?: "PAYER" | "BENEFICIARY";
}

export interface ExecutionGateway<T extends GatewayTransfer = GatewayTransfer> {
  getBalances(): Promise<GatewayBalance[]>;
  createQuote(input: QuoteRequest): Promise<GatewayQuote>;
  createConversion(input: ConversionRequest): Promise<GatewayConversion>;
  findConversionByRequestId(requestId: string): Promise<GatewayConversion | null>;
  getBeneficiary(id: string): Promise<GatewayBeneficiary>;
  createTransfer(input: TransferRequest): Promise<T>;
}

/** What a failed outbound call means for the attempt (ADR 0007). */
export type FailureKind = "rate_limited" | "rejected" | "unknown";

export interface FailureDetail {
  readonly kind: string;
  readonly code?: string;
  readonly message: string;
}

/**
 * `rate_limited`: 429, nothing was processed, retry with the same request_id. `rejected`: Airwallex
 * answered 4xx (or the adapter refused to send), so nothing was created. Anything else (timeout,
 * network error, 5xx, an unreadable answer) is `unknown`: look the object up, never send a new id.
 */
export function classifyFailure(error: unknown): { kind: FailureKind; detail: FailureDetail } {
  const e = error as { name?: unknown; status?: unknown; code?: unknown; message?: unknown };
  const detail: FailureDetail = {
    kind: typeof e?.name === "string" ? e.name : "Error",
    ...(typeof e?.code === "string" ? { code: e.code } : {}),
    message: typeof e?.message === "string" ? e.message : String(error),
  };
  const status = typeof e?.status === "number" ? e.status : undefined;
  if (status === 429) return { kind: "rate_limited", detail };
  if (status !== undefined && status >= 400 && status < 500) return { kind: "rejected", detail };
  if (e?.name === "AirwallexInputError") return { kind: "rejected", detail };
  return { kind: "unknown", detail };
}
