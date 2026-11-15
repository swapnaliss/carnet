// The payout executor (M3-03, ADR 0007, 0008). A payout is never auto-approved: it runs only on an
// approval whose hash covers business, approver, nonce, source account and currency, the beneficiary
// fingerprint, amount, currency, fee option, value date, reference and counterparty.
//
//   kill switch ─▶ consumeApproval (atomic: approval CONSUMED + attempt INTENT in one transaction)
//   ─▶ kill switch again ─▶ re-read the payment, counterparty, beneficiary and balance
//   ─▶ RE-DERIVE the approval hash from that live state: any difference refuses (attempt REJECTED)
//   ─▶ attempt SENT_TO_AIRWALLEX ─▶ createTransfer(the attempt's request_id)
//        ├─ 2xx ──▶ CONFIRMED          ├─ 4xx ──▶ REJECTED          └─ timeout / 5xx ──▶ UNKNOWN
//
// UNKNOWN is resolved by the existing reconcile pass (lookup by request_id, never a new id). The attempt
// is kind `transfer` with the payment id as `ref_id`, the shape M1-08 and that pass already use.
import {
  type AnySubject,
  type AttemptId,
  approvalHash,
  type BusinessId,
  beneficiaryFingerprint,
  type CounterpartyId,
  type Currency,
  type PayoutSubject,
  type UserId,
} from "@carnet/domain";
import { and, eq } from "drizzle-orm";
import { appendAudit } from "../audit/append";
import { getStoredAction, isActionCurrent, transitionAction } from "../repos/action-states";
import { type Approval, consumeApproval, endApproval, getApproval } from "../repos/approvals";
import { repoCtx } from "../repos/context";
import { getCounterparty } from "../repos/counterparties";
import {
  claimAttempt,
  getAttempt,
  releaseAttempt,
  updateAttemptStatus,
} from "../repos/execution-attempts";
import { businesses, payments } from "../schema/index";
import {
  type AttemptRecord,
  EXECUTOR_LEASE_MS,
  type ExecutorDeps,
  executionEnabled,
  loggerOf,
  nowOf,
  Rollback,
  recordOf,
  withoutLease,
} from "./common";
import { classifyFailure, type ExecutionGateway, type GatewayTransfer } from "./gateway";

/** The transfer reason Carnet sends for supplier payments (accepted in every M0-03 recording). */
export const PAYOUT_REASON = "professional_business_services";

export type PayoutOutcome<T extends GatewayTransfer = GatewayTransfer> =
  | { outcome: "skipped"; reason: string }
  | { outcome: "refused"; reason: string; attemptId?: AttemptId }
  | { outcome: "confirmed"; attemptId: AttemptId; transfer: T }
  | { outcome: "unknown"; attemptId: AttemptId; error: string }
  | { outcome: "rejected"; attemptId: AttemptId; error: string };

export interface PayoutDeps<T extends GatewayTransfer = GatewayTransfer> extends ExecutorDeps<T> {
  /** Called after the transfer is created (the worker applies it to the payment, as M1-08 does). */
  readonly onTransfer?: (transfer: T) => Promise<void>;
}

export interface LivePayout {
  readonly subject: PayoutSubject;
  readonly beneficiaryId: string;
  readonly method: "LOCAL" | "SWIFT";
  readonly sourceCurrency: Currency;
  readonly transferCurrency: Currency;
  readonly amount: { minor: bigint; currency: Currency };
  readonly alreadySentAs: string | null;
}

/**
 * The payout subject as the live state says it is: the payment, its counterparty, the business's
 * Airwallex account and the beneficiary as Airwallex returns it now. M3-04 builds the subject an
 * approver sees with this; the executor builds it again to compare. A string is a refusal code.
 */
export async function currentPayoutSubject(
  deps: Pick<ExecutorDeps, "db" | "gateway">,
  businessId: BusinessId,
  paymentId: string,
  who: { approverId: UserId; nonce: string },
): Promise<LivePayout | string> {
  const rc = repoCtx(deps.db, businessId);
  const [p] = await deps.db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.businessId, businessId)));
  if (!p) return "NO_PAYMENT";
  if (p.method !== "LOCAL" && p.method !== "SWIFT") return "UNSUPPORTED_METHOD";
  if (!p.counterpartyId) return "NO_COUNTERPARTY";
  const counterparty = await getCounterparty(rc, p.counterpartyId as CounterpartyId);
  if (!counterparty?.beneficiaryId) return "NO_BENEFICIARY";
  const [biz] = await deps.db
    .select({ account: businesses.airwallexAccountId })
    .from(businesses)
    .where(eq(businesses.id, businessId));
  const beneficiary = await deps.gateway.getBeneficiary(counterparty.beneficiaryId);
  const subject: PayoutSubject = {
    kind: "payout",
    businessId,
    approverId: who.approverId,
    nonce: who.nonce,
    paymentId,
    sourceAccount: biz?.account ?? "",
    sourceCurrency: p.sourceCurrency,
    beneficiaryFingerprint: beneficiaryFingerprint(beneficiary),
    amountMinor: p.amountMinor.toString(),
    currency: p.currency,
    feeOption: p.feeOption,
    valueDate: p.valueDate ?? "",
    reference: p.reference,
    counterpartyId: counterparty.id,
  };
  return {
    subject,
    beneficiaryId: counterparty.beneficiaryId,
    method: p.method,
    sourceCurrency: p.sourceCurrency as Currency,
    transferCurrency: p.currency as Currency,
    amount: { minor: p.amountMinor, currency: p.currency as Currency },
    alreadySentAs: p.transferId,
  };
}

export interface PayoutInput {
  approvalId: Approval["id"];
  /** The hash the caller was told to execute (the job payload). */
  expectedHash: string;
  /** The plan action this payout belongs to, when it came from a plan. */
  actionId?: string;
}

export async function executePayout<T extends GatewayTransfer>(
  deps: PayoutDeps<T>,
  businessId: BusinessId,
  input: PayoutInput,
): Promise<PayoutOutcome<T>> {
  const log = loggerOf(deps);
  const rc = repoCtx(deps.db, businessId);
  if (!(await executionEnabled(deps.db))) return { outcome: "skipped", reason: "KILL_SWITCH" };

  const approval = await getApproval(rc, input.approvalId);
  if (!approval || approval.kind !== "payout") return { outcome: "refused", reason: "NOT_FOUND" };
  const paymentId = approval.subjectRef;

  // An alternate payout pays a HELD payment's obligation another way (ADR 0021 rule 3): that payment
  // already has its transfer, so "already sent" is expected, and the new transfer never replaces the
  // held one on the payment (the held transfer keeps its own status, ADR 0006).
  let alternate = false;
  if (input.actionId !== undefined) {
    const stored = await getStoredAction(rc, input.actionId);
    if (!stored) return { outcome: "refused", reason: "NO_ACTION" };
    if (stored.state === "SUPERSEDED" || !(await isActionCurrent(rc, stored))) {
      await endApproval(rc, approval.id, "REJECTED", "SUPERSEDED");
      return { outcome: "refused", reason: "SUPERSEDED" };
    }
    alternate =
      stored.action.kind === "payout" &&
      stored.action.reason_code === "PAYOUT_ALTERNATE_FOR_HELD" &&
      stored.action.params.held_payment_id === paymentId;
  }

  const consumed = await consumeApproval(rc, {
    approvalId: input.approvalId,
    expectedHash: input.expectedHash,
    inTransaction: async (tx, a, attempt) => {
      if (input.actionId !== undefined) {
        const moved = await transitionAction(
          tx,
          input.actionId,
          ["PROPOSED", "APPROVED"],
          "EXECUTING",
          { attemptId: attempt.id },
        );
        if (!moved) throw new Rollback("ACTION_NOT_EXECUTABLE");
      }
      await appendAudit(tx, {
        actorType: "system",
        actorId: a.approverId,
        action: "payout.approval_consumed",
        subject: paymentId,
        data: {
          approvalId: a.id,
          hash: a.hash,
          attemptId: attempt.id,
          requestId: attempt.requestId,
        },
      });
    },
  }).catch((error: unknown) => {
    if (error instanceof Rollback) return { outcome: "refused", reason: error.reason } as const;
    throw error;
  });
  if (consumed.outcome === "refused") return { outcome: "refused", reason: consumed.reason };
  const attempt = consumed.attempt;

  const refuse = async (reason: string): Promise<PayoutOutcome<T>> => {
    await updateAttemptStatus(rc, attempt.id, "REJECTED", {
      ...withoutLease(recordOf(attempt)),
      refusal: reason,
    } satisfies AttemptRecord);
    if (input.actionId !== undefined) {
      await transitionAction(rc, input.actionId, ["EXECUTING"], "PROPOSED", { reason });
    }
    await appendAudit(rc, {
      actorType: "system",
      action: "payout.refused",
      subject: paymentId,
      data: { attemptId: attempt.id, reason },
    });
    log.warn({ paymentId, attemptId: attempt.id, reason }, "approved payout refused; nothing sent");
    return { outcome: "refused", reason, attemptId: attempt.id };
  };

  if (!(await executionEnabled(deps.db))) return refuse("KILL_SWITCH");

  const live = await currentPayoutSubject(deps, businessId, paymentId, {
    approverId: approval.approverId,
    nonce: approval.nonce,
  });
  if (typeof live === "string") return refuse(live);
  // A plain payout must not send twice; an alternate payout is only for a payment already in flight.
  if (!alternate && live.alreadySentAs !== null) return refuse("ALREADY_SENT");
  if (alternate && live.alreadySentAs === null) return refuse("NOT_IN_FLIGHT");
  if (approvalHash(live.subject as AnySubject) !== approval.hash) return refuse("HASH_MISMATCH");

  const balances = await deps.gateway.getBalances();
  const have = balances.find((b) => b.currency === live.sourceCurrency)?.available.minor ?? 0n;
  if (have < live.amount.minor) return refuse("INSUFFICIENT_BALANCE");

  return sendTransfer(deps, businessId, {
    attemptId: attempt.id,
    live,
    paymentId,
    reference: live.subject.reference,
    feeOption: live.subject.feeOption,
    alternate,
    ...(input.actionId === undefined ? {} : { actionId: input.actionId }),
  });
}

async function sendTransfer<T extends GatewayTransfer>(
  deps: PayoutDeps<T>,
  businessId: BusinessId,
  args: {
    attemptId: AttemptId;
    live: LivePayout;
    paymentId: string;
    reference: string;
    feeOption: string;
    /** An alternate payout: the transfer is not applied to the held payment. */
    alternate: boolean;
    actionId?: string;
  },
): Promise<PayoutOutcome<T>> {
  const log = loggerOf(deps);
  const rc = repoCtx(deps.db, businessId);
  const { attemptId, live } = args;
  const attempt = await getAttempt(rc, attemptId);
  if (attempt?.kind !== "transfer") throw new Error("transfer attempt not found");
  const claimed = await claimAttempt(
    rc,
    attemptId,
    ["INTENT", "SENT_TO_AIRWALLEX"],
    EXECUTOR_LEASE_MS,
  );
  if (!claimed) return { outcome: "skipped", reason: "HELD_BY_ANOTHER_EXECUTOR" };
  try {
    const prior = recordOf(claimed);
    const sending: AttemptRecord = {
      ...prior,
      sentAt: prior.sentAt ?? nowOf(deps).toISOString(),
      sends: (prior.sends ?? 0) + 1,
    };
    await updateAttemptStatus(rc, attemptId, "SENT_TO_AIRWALLEX", sending);
    log.info(
      { paymentId: args.paymentId, attemptId, requestId: attempt.requestId },
      "sending approved payout to Airwallex",
    );
    let transfer: T;
    try {
      transfer = await (deps.gateway as ExecutionGateway<T>).createTransfer({
        requestId: attempt.requestId,
        beneficiaryId: live.beneficiaryId,
        sourceCurrency: live.sourceCurrency,
        transferCurrency: live.transferCurrency,
        sourceAmount: live.amount,
        transferMethod: live.method,
        reason: PAYOUT_REASON,
        reference: args.reference,
        ...(args.feeOption === "PAYER" || args.feeOption === "BENEFICIARY"
          ? { feePaidBy: args.feeOption }
          : {}),
      });
    } catch (error) {
      const failure = classifyFailure(error);
      if (failure.kind === "rate_limited") {
        await releaseAttempt(rc, attemptId);
        throw error;
      }
      const status = failure.kind === "rejected" ? "REJECTED" : "UNKNOWN";
      await updateAttemptStatus(rc, attemptId, status, {
        ...withoutLease(sending),
        error: failure.detail,
      });
      if (failure.kind === "rejected" && args.actionId !== undefined) {
        await transitionAction(rc, args.actionId, ["EXECUTING"], "FAILED", {
          reason: failure.detail.code ?? "REJECTED",
        });
      }
      await appendAudit(rc, {
        actorType: "system",
        action: failure.kind === "rejected" ? "payout.rejected" : "payout.unknown",
        subject: args.paymentId,
        data: { attemptId, requestId: attempt.requestId, error: failure.detail },
      });
      if (failure.kind === "unknown") {
        log.error(
          {
            attemptId,
            requestId: attempt.requestId,
            error: failure.detail,
            alert: "attempt_unknown",
          },
          "payout outcome unknown; the reconciler will look it up by request_id",
        );
        return { outcome: "unknown", attemptId, error: failure.detail.message };
      }
      return { outcome: "rejected", attemptId, error: failure.detail.message };
    }
    await updateAttemptStatus(rc, attemptId, "CONFIRMED", {
      ...withoutLease(sending),
      confirmedAt: nowOf(deps).toISOString(),
      transferId: transfer.id,
      status: transfer.status,
    } satisfies AttemptRecord);
    if (args.actionId !== undefined) {
      await transitionAction(rc, args.actionId, ["EXECUTING"], "DONE", { reason: null });
    }
    await appendAudit(rc, {
      actorType: "system",
      action: "payout.confirmed",
      subject: args.paymentId,
      data: {
        attemptId,
        transferId: transfer.id,
        status: transfer.status,
        ...(args.alternate ? { alternateFor: args.paymentId } : {}),
      },
    });
    if (deps.onTransfer && !args.alternate) await deps.onTransfer(transfer);
    return { outcome: "confirmed", attemptId, transfer };
  } catch (error) {
    await releaseAttempt(rc, attemptId).catch(() => undefined);
    throw error;
  }
}
