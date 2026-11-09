// `answer.submitted` (M2-07 publishes it after a CONFIRMED respond; M2-06 consumes it): remembers the
// approved answers so a follow-up round can reuse them. Memory is written only for a CONSUMED approval
// whose respond attempt is CONFIRMED (`recordApprovedAnswers`), in one transaction with its audit row.
// Idempotent: a redelivered event writes nothing twice.
import { appendAudit, recordApprovedAnswers, repoCtx, withTransaction } from "@carnet/db";
import type { ApprovalId, AttemptId, BusinessId, RfiId } from "@carnet/domain";
import { type JobHandler, payloadOptionalString, payloadString } from "./index";

export const handleAnswerSubmittedMemory: JobHandler = async (payload, ctx) => {
  const businessId = payloadString(payload, "businessId") as BusinessId;
  const rfiId = payloadString(payload, "rfiId") as RfiId;
  const approvalId = payloadString(payload, "approvalId") as ApprovalId;
  const attemptId = payloadOptionalString(payload, "attemptId") as AttemptId | null;
  const outcome = await withTransaction(ctx.db, async (tx) => {
    const rc = repoCtx(tx, businessId);
    const result = await recordApprovedAnswers(rc, { rfiId, approvalId, attemptId });
    await appendAudit(rc, {
      actorType: "system",
      actorId: "worker",
      action: "answer.memorised",
      subject: `rfi:${rfiId}`,
      data: { approvalId, attemptId, recorded: result.recorded, skipped: result.skipped },
    });
    return result;
  });
  ctx.logger.info({ businessId, rfiId, approvalId, ...outcome }, "answer memory updated");
};
