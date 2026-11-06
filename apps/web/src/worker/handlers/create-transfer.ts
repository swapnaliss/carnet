// `transfer.create` (ADR 0007, M1-08): send the Airwallex transfer for a payment's persisted attempt.
//
//   INTENT ──(stamp sentAt, commit)──▶ SENT_TO_AIRWALLEX ──createTransfer(same request_id)──▶ CONFIRMED
//                                                         ├─ timeout / 5xx / network ──────▶ UNKNOWN
//                                                         └─ 4xx (not 429) ────────────────▶ REJECTED
//
// The attempt row and its request_id were written by the API in the same transaction as the payment,
// before this job could run, so the attempt always exists before the outbound call. The request_id
// is never replaced: a re-run (retry, expired lease) sends the same one, and Airwallex answers a
// repeat with `duplicate_request_id`, which the adapter turns into a fetch of the existing transfer.
// UNKNOWN is left to the reconcile pass (lookup by request_id, never a second create). A 429 is
// thrown, so the job retries later with the same request_id.
import {
  AirwallexApiError,
  AirwallexRateLimited,
  type BeneficiaryDetails,
  type Transfer,
  type TransferMethod,
} from "@carnet/airwallex";
import {
  type ExecutionAttempt,
  getAttempt,
  getCounterparty,
  getPayment,
  type Payment,
  type RepoCtx,
  repoCtx,
  updateAttemptStatus,
  updateCounterparty,
} from "@carnet/db";
import type { AttemptId, BusinessId, PaymentId, RequestId } from "@carnet/domain";
import {
  type AirwallexWriter,
  type HandlerContext,
  type JobHandler,
  payloadString,
  requireWriter,
} from "./index";
import { applyFetchedTransfer } from "./transfer";

/** The transfer reason Carnet sends for supplier payments (accepted in every M0-03 recording). */
export const TRANSFER_REASON = "professional_business_services";

/**
 * The demo counterparty's bank details: the synthetic US USD LOCAL beneficiary the M0-03 spike
 * validated and created (fixture `beneficiary-create-us-usd-local`). Synthetic data only.
 */
export const DEMO_BENEFICIARY: BeneficiaryDetails = {
  entity_type: "COMPANY",
  company_name: "Northwind Test Supplies LLC",
  address: {
    country_code: "US",
    postcode: "10001",
    street_address: "350 Fifth Avenue",
    city: "New York",
    state: "US-NY",
  },
  bank_details: {
    account_currency: "USD",
    bank_country_code: "US",
    account_name: "Northwind Test Supplies LLC",
    account_number: "1234567890",
    account_routing_type1: "aba",
    account_routing_value1: "021000021",
    bank_account_category: "Checking",
  },
  type: "BANK_ACCOUNT",
};

/** What `execution_attempts.response` holds for a transfer attempt (timestamps are ISO strings). */
export interface TransferAttemptRecord {
  /** When the worker committed SENT_TO_AIRWALLEX, immediately before the outbound create call. */
  readonly sentAt?: string;
  /** How many times the create call was started for this attempt (a re-run reuses the request_id). */
  readonly sends?: number;
  readonly confirmedAt?: string;
  readonly transferId?: string;
  readonly status?: string;
  readonly error?: { readonly kind: string; readonly code?: string; readonly message: string };
  readonly resolvedBy?: string;
}

export function attemptRecord(attempt: Pick<ExecutionAttempt, "response">): TransferAttemptRecord {
  const r = attempt.response;
  return typeof r === "object" && r !== null ? (r as TransferAttemptRecord) : {};
}

export type TransferCreateOutcome =
  | { outcome: "confirmed"; transfer: Transfer }
  | { outcome: "unknown"; error: string }
  | { outcome: "rejected"; error: string }
  | { outcome: "skipped"; status: string };

const isMethod = (m: string): m is TransferMethod => m === "LOCAL" || m === "SWIFT";

/** The counterparty's Airwallex beneficiary id, created through the adapter the first time. */
async function ensureBeneficiary(
  ctx: HandlerContext,
  writer: AirwallexWriter,
  rc: RepoCtx,
  payment: Payment,
): Promise<string> {
  if (!payment.counterpartyId) throw new Error("payment has no counterparty");
  const counterparty = await getCounterparty(rc, payment.counterpartyId);
  if (!counterparty) throw new Error("counterparty not found");
  if (counterparty.beneficiaryId) return counterparty.beneficiaryId;
  // The counterparty id is the beneficiary's request_id: one counterparty, one create intent.
  const created = await writer.createBeneficiary({
    requestId: counterparty.id as string as RequestId,
    nickname: `carnet-${counterparty.id.slice(0, 8)}`,
    beneficiary: DEMO_BENEFICIARY,
    transferMethods: ["LOCAL"],
  });
  await updateCounterparty(rc, counterparty.id, { beneficiaryId: created.id });
  ctx.logger.info(
    { counterpartyId: counterparty.id, beneficiaryId: created.id },
    "beneficiary created for counterparty",
  );
  return created.id;
}

function errorOf(error: unknown): { kind: string; code?: string; message: string } {
  if (error instanceof AirwallexApiError) {
    return { kind: error.name, code: error.code, message: error.message };
  }
  return {
    kind: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** A definite refusal: Airwallex answered 4xx (other than 429), so nothing was created. */
function isRejection(error: unknown): boolean {
  return (
    error instanceof AirwallexApiError &&
    !(error instanceof AirwallexRateLimited) &&
    error.status >= 400 &&
    error.status < 500
  );
}

export async function executeTransferAttempt(
  ctx: HandlerContext,
  businessId: BusinessId,
  attemptId: AttemptId,
  now: () => Date = () => new Date(),
): Promise<TransferCreateOutcome> {
  const rc = repoCtx(ctx.db, businessId);
  const attempt = await getAttempt(rc, attemptId);
  if (attempt?.kind !== "transfer") throw new Error("transfer attempt not found");
  if (attempt.status !== "INTENT" && attempt.status !== "SENT_TO_AIRWALLEX") {
    // CONFIRMED and REJECTED are done; UNKNOWN belongs to the reconciler (lookup, never resend).
    ctx.logger.info(
      { attemptId, status: attempt.status },
      "transfer attempt already past sending; nothing to do",
    );
    return { outcome: "skipped", status: attempt.status };
  }
  const payment = await getPayment(rc, attempt.refId as PaymentId);
  if (!payment) throw new Error("payment for the attempt not found");
  if (!isMethod(payment.method)) throw new Error(`unsupported transfer method ${payment.method}`);
  const writer = requireWriter(ctx);
  const beneficiaryId = await ensureBeneficiary(ctx, writer, rc, payment);

  const prior = attemptRecord(attempt);
  const sentAt = now().toISOString();
  const sending: TransferAttemptRecord = {
    sentAt: prior.sentAt ?? sentAt,
    sends: (prior.sends ?? 0) + 1,
  };
  // Committed before the call: a crash from here on leaves SENT_TO_AIRWALLEX, and a re-run sends
  // the same request_id again (de-duplicated by Airwallex).
  await updateAttemptStatus(rc, attempt.id, "SENT_TO_AIRWALLEX", sending);
  ctx.logger.info(
    { attemptId, requestId: attempt.requestId, paymentId: payment.id, sends: sending.sends },
    "sending transfer to Airwallex",
  );

  let transfer: Transfer;
  try {
    transfer = await writer.createTransfer({
      requestId: attempt.requestId,
      beneficiaryId,
      sourceCurrency: payment.sourceCurrency,
      transferCurrency: payment.amount.currency,
      sourceAmount: payment.amount,
      transferMethod: payment.method,
      reason: TRANSFER_REASON,
      reference: payment.reference,
    });
  } catch (error) {
    if (error instanceof AirwallexRateLimited) throw error; // retried later, same request_id
    const detail = errorOf(error);
    if (isRejection(error)) {
      await updateAttemptStatus(rc, attempt.id, "REJECTED", { ...sending, error: detail });
      ctx.logger.warn({ attemptId, error: detail }, "Airwallex rejected the transfer");
      return { outcome: "rejected", error: detail.message };
    }
    await updateAttemptStatus(rc, attempt.id, "UNKNOWN", { ...sending, error: detail });
    ctx.logger.error(
      { attemptId, requestId: attempt.requestId, error: detail, alert: "attempt_unknown" },
      "transfer outcome unknown; the reconciler will look it up by request_id",
    );
    return { outcome: "unknown", error: detail.message };
  }

  await updateAttemptStatus(rc, attempt.id, "CONFIRMED", {
    ...sending,
    confirmedAt: now().toISOString(),
    transferId: transfer.id,
    status: transfer.status,
  });
  ctx.logger.info(
    { attemptId, transferId: transfer.id, status: transfer.status },
    "transfer created in Airwallex",
  );
  await applyFetchedTransfer(ctx, transfer, { businessId, paymentId: payment.id });
  return { outcome: "confirmed", transfer };
}

/** Payload: `{ attemptId, businessId }`, written with the payment by `POST /api/v1/payments`. */
export const handleTransferCreate: JobHandler = async (payload, ctx) => {
  const attemptId = payloadString(payload, "attemptId") as AttemptId;
  const businessId = payloadString(payload, "businessId") as BusinessId;
  await executeTransferAttempt(ctx, businessId, attemptId);
};
