// Approvals that ended without being consumed (M2-07): TTL and the kill switch. Run by the reconcile pass
// (a non-mutating job, so it runs while execution is off). Each ended approval is audited, and when its
// RFI is still APPROVED the RFI goes back to DRAFT_READY (`approval.revoked`): the draft returns to the
// owner, who must approve again. An attempt already past INTENT is not an approval and is untouched.
import {
  appendAudit,
  type EndedApprovalRef,
  expireAllLiveApprovalsForKillSwitch,
  expireDueApprovals,
  getRfiForUpdate,
  getSystemFlags,
  type Rfi,
  repoCtx,
  withTransaction,
} from "@carnet/db";
import { moveRfi } from "../server/rfi-state";
import type { HandlerContext } from "./handlers/index";

export interface ApprovalSweepSummary {
  ttlExpired: number;
  killSwitchExpired: number;
}

async function revoke(
  ctx: HandlerContext,
  ref: EndedApprovalRef,
  reason: "TTL" | "KILL_SWITCH",
): Promise<void> {
  await withTransaction(ctx.db, async (tx) => {
    const rc = repoCtx(tx, ref.businessId);
    await appendAudit(rc, {
      actorType: "system",
      actorId: "worker",
      action: "approval.expired",
      subject: `rfi:${ref.subjectRef}`,
      data: { approvalId: ref.id, reason },
    });
    const rfi = await getRfiForUpdate(rc, ref.subjectRef as Rfi["id"]);
    if (rfi?.state === "APPROVED") {
      await moveRfi(
        rc,
        rfi,
        "DRAFT_READY",
        { actorType: "system", actorId: "worker" },
        "approval",
        {
          approvalId: ref.id,
          reason,
        },
      );
    }
  });
}

export async function sweepApprovals(
  ctx: HandlerContext,
  now: Date = new Date(),
): Promise<ApprovalSweepSummary> {
  const summary: ApprovalSweepSummary = { ttlExpired: 0, killSwitchExpired: 0 };
  let enabled = true;
  try {
    enabled = (await getSystemFlags(ctx.db)).executionEnabled;
  } catch {
    enabled = false; // fail closed, like the loop's kill-switch read
  }
  if (!enabled) {
    for (const ref of await expireAllLiveApprovalsForKillSwitch(ctx.db)) {
      await revoke(ctx, ref, "KILL_SWITCH");
      summary.killSwitchExpired += 1;
    }
  }
  for (const ref of await expireDueApprovals(ctx.db, now)) {
    await revoke(ctx, ref, "TTL");
    summary.ttlExpired += 1;
  }
  return summary;
}
