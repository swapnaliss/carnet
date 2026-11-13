// Worker handlers for the executors (M3-03, packages/db/src/executors). Each is a thin shell: it reads a
// job payload, builds the executor's dependencies (the mutating Airwallex client, the planner's flat SWIFT
// fee from config/fees.json) and calls the executor, which owns every rule (kill switch, policy, attempt
// before the call, bound approvals). All are registered `mutating: true`, so the loop also checks the kill
// switch before running them.
//
//   conversion.execute            { businessId, actionId }                        auto-FX under policy
//   conversion.execute_approved   { businessId, approvalId, hash }                owner-approved conversion
//   payout.execute                { businessId, approvalId, hash, paymentId, actionId? }  owner-approved payout
//   plan.execute                  { businessId, planId }                          a plan's convert actions in order
import type { Transfer } from "@carnet/airwallex";
import {
  type ExecutionGateway,
  type ExecutorDeps,
  executeApprovedConversion,
  executeAutoConversion,
  executePayout,
  runConversionActions,
} from "@carnet/db";
import type { ApprovalId, BusinessId, Currency, PaymentId } from "@carnet/domain";
import { loadPlannerConfig } from "../../server/planner-config";
import {
  type HandlerContext,
  type HandlerRegistry,
  type JobHandler,
  payloadOptionalString,
  payloadString,
  registerHandler,
  requireWriter,
} from "./index";
import { applyFetchedTransfer } from "./transfer";

export const EXECUTE_JOB_KIND = {
  conversionAuto: "conversion.execute",
  conversionApproved: "conversion.execute_approved",
  payout: "payout.execute",
  plan: "plan.execute",
} as const;

let swiftFees: Map<Currency, bigint> | null = null;
function swiftPayoutFeeMinor(currency: Currency): bigint {
  if (swiftFees === null) {
    swiftFees = new Map(loadPlannerConfig().swiftPayoutFee.map((f) => [f.currency, f.minor]));
  }
  return swiftFees.get(currency) ?? 0n;
}

/** The executors' dependencies for this worker: the mutating client is the gateway. */
export function executorDeps(ctx: HandlerContext): ExecutorDeps<Transfer> {
  return {
    db: ctx.db,
    gateway: requireWriter(ctx) as unknown as ExecutionGateway<Transfer>,
    logger: ctx.logger,
    swiftPayoutFeeMinor,
  };
}

const businessOf = (payload: unknown): BusinessId =>
  payloadString(payload, "businessId") as BusinessId;

export const handleConversionAuto: JobHandler = async (payload, ctx) => {
  const actionId = payloadString(payload, "actionId");
  const r = await executeAutoConversion(executorDeps(ctx), businessOf(payload), actionId);
  ctx.logger.info({ actionId, ...r }, "auto conversion handled");
};

export const handleConversionApproved: JobHandler = async (payload, ctx) => {
  const r = await executeApprovedConversion(executorDeps(ctx), businessOf(payload), {
    approvalId: payloadString(payload, "approvalId") as ApprovalId,
    expectedHash: payloadString(payload, "hash"),
  });
  ctx.logger.info({ ...r }, "approved conversion handled");
};

export const handlePayoutExecute: JobHandler = async (payload, ctx) => {
  const businessId = businessOf(payload);
  const actionId = payloadOptionalString(payload, "actionId");
  const deps = executorDeps(ctx);
  const r = await executePayout(
    {
      ...deps,
      // The same step M1-08 takes after a created transfer: apply it to its payment.
      onTransfer: async (transfer: Transfer) => {
        await applyFetchedTransfer(ctx, transfer, {
          businessId,
          paymentId: payloadString(payload, "paymentId") as PaymentId,
        });
      },
    },
    businessId,
    {
      approvalId: payloadString(payload, "approvalId") as ApprovalId,
      expectedHash: payloadString(payload, "hash"),
      ...(actionId === null ? {} : { actionId }),
    },
  );
  ctx.logger.info({ ...r }, "approved payout handled");
};

export const handlePlanExecute: JobHandler = async (payload, ctx) => {
  const planId = payloadString(payload, "planId");
  const summary = await runConversionActions(executorDeps(ctx), businessOf(payload), planId);
  ctx.logger.info({ planId, ...summary }, "plan actions executed");
};

export function registerExecuteHandlers(registry: HandlerRegistry): HandlerRegistry {
  registerHandler(registry, EXECUTE_JOB_KIND.conversionAuto, handleConversionAuto, {
    mutating: true,
  });
  registerHandler(registry, EXECUTE_JOB_KIND.conversionApproved, handleConversionApproved, {
    mutating: true,
  });
  registerHandler(registry, EXECUTE_JOB_KIND.payout, handlePayoutExecute, { mutating: true });
  registerHandler(registry, EXECUTE_JOB_KIND.plan, handlePlanExecute, { mutating: true });
  return registry;
}
