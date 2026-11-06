// `transfer.simulate` (M1-08, ADR 0018): an owner asked the sandbox to move a payment's transfer to
// SENT or PAID. Calls only the real `/simulation/transfers/{id}/transition` endpoint through the
// SandboxSimulator port, then applies the transfer it returns exactly like a fetched one (the webhook
// that follows is applied the same way and is a no-op if it carries nothing newer).
// The sandbox accepts SENT only once the transfer is PROCESSING (it gets there by itself about a second
// after creation), so a 5xx is thrown and the job retries with backoff. Idempotent: a transfer already
// at or past the requested status is left alone.
import { AirwallexApiError } from "@carnet/airwallex";
import { getPayment, repoCtx } from "@carnet/db";
import {
  type BusinessId,
  type PaymentId,
  rank,
  SIMULATED_TRANSITIONS,
  type SimulatedTransition,
} from "@carnet/domain";
import { type JobHandler, payloadString, requireWriter } from "./index";
import { applyFetchedTransfer } from "./transfer";

function transitionOf(value: string): SimulatedTransition {
  if ((SIMULATED_TRANSITIONS as readonly string[]).includes(value)) {
    return value as SimulatedTransition;
  }
  throw new Error(`unsupported simulated transition ${value}`);
}

/** Payload: `{ paymentId, businessId, nextStatus }`, written by the simulate route. */
export const handleTransferSimulate: JobHandler = async (payload, ctx) => {
  const paymentId = payloadString(payload, "paymentId") as PaymentId;
  const businessId = payloadString(payload, "businessId") as BusinessId;
  const nextStatus = transitionOf(payloadString(payload, "nextStatus"));
  const payment = await getPayment(repoCtx(ctx.db, businessId), paymentId);
  if (!payment?.transferId) throw new Error("payment has no transfer yet");
  const writer = requireWriter(ctx);

  const current = await ctx.airwallex.getTransfer(payment.transferId);
  if (rank(current.status) >= rank(nextStatus)) {
    ctx.logger.info(
      { paymentId, transferId: current.id, status: current.status, nextStatus },
      "transfer already at or past the simulated status",
    );
    await applyFetchedTransfer(ctx, current, { businessId, paymentId });
    return;
  }
  try {
    const { transfer, confirmedAfterError } = await writer.simulator.transitionTransfer(
      payment.transferId,
      nextStatus,
    );
    ctx.logger.info(
      { paymentId, transferId: transfer.id, nextStatus, confirmedAfterError },
      "sandbox transition applied",
    );
    // The transition response can name the requested status before a fetch does; read it back.
    await applyFetchedTransfer(ctx, await ctx.airwallex.getTransfer(transfer.id), {
      businessId,
      paymentId,
    });
  } catch (error) {
    if (error instanceof AirwallexApiError && error.status < 500) {
      ctx.logger.warn(
        { paymentId, nextStatus, code: error.code, status: error.status },
        "sandbox refused the transition; not retried",
      );
      return;
    }
    throw error; // 5xx (e.g. still SCHEDULED): retry with backoff
  }
};
