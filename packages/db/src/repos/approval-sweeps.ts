// Approval sweeps (ADR 0008, M2-07). System functions: they take `db`, run from the worker and touch
// every tenant, and are not reachable from a request. The worker then moves each RFI back through a
// tenant context.
import type { ApprovalId, BusinessId } from "@carnet/domain";
import { and, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../client";
import { approvals } from "../schema/index";

export interface EndedApprovalRef {
  readonly id: ApprovalId;
  readonly businessId: BusinessId;
  readonly subjectRef: string;
}

/**
 * Kill switch: every PENDING or APPROVED approval of every business becomes EXPIRED / KILL_SWITCH. An
 * attempt already past INTENT is not an approval and is untouched (it continues to resolution).
 */
export async function expireAllLiveApprovalsForKillSwitch(db: Db): Promise<EndedApprovalRef[]> {
  const rows = await db
    .update(approvals)
    .set({ status: "EXPIRED", endReason: "KILL_SWITCH", updatedAt: sql`now()` })
    .where(inArray(approvals.status, ["PENDING", "APPROVED"]))
    .returning({
      id: approvals.id,
      businessId: approvals.businessId,
      subjectRef: approvals.subjectRef,
    });
  return rows.map((r) => ({
    id: r.id as ApprovalId,
    businessId: r.businessId as BusinessId,
    subjectRef: r.subjectRef,
  }));
}

/** TTL: live approvals past `expires_at` become EXPIRED / TTL. */
export async function expireDueApprovals(db: Db, now: Date): Promise<EndedApprovalRef[]> {
  const rows = await db
    .update(approvals)
    .set({ status: "EXPIRED", endReason: "TTL", updatedAt: sql`now()` })
    .where(and(inArray(approvals.status, ["PENDING", "APPROVED"]), lte(approvals.expiresAt, now)))
    .returning({
      id: approvals.id,
      businessId: approvals.businessId,
      subjectRef: approvals.subjectRef,
    });
  return rows.map((r) => ({
    id: r.id as ApprovalId,
    businessId: r.businessId as BusinessId,
    subjectRef: r.subjectRef,
  }));
}
