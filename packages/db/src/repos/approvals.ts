// Approvals (ADR 0008, M2-07). Tenant repository: every function takes `ctx` first and scopes every
// statement by `ctx.businessId`; the two sweeps at the bottom are system functions (they take `db`,
// run from the worker and touch every tenant) and are not reachable from a request.
//
// `consumeApproval` is the only way an approval is consumed: ONE transaction runs
//   UPDATE approvals SET status='CONSUMED' WHERE id=? AND status='APPROVED' AND hash=? AND expires_at > now()
// and inserts the ExecutionAttempt (kind respond, status INTENT, request_id minted once). Zero rows
// means refuse and nothing is written; a failure after the UPDATE rolls the consume back with it.
import {
  type ApprovalEndReason,
  type ApprovalId,
  type ApprovalKind,
  type ApprovalStatus,
  type AttemptId,
  type BusinessId,
  newApprovalId,
  newAttemptId,
  newRequestId,
  type RequestId,
  type UserId,
} from "@carnet/domain";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { withTransaction } from "../client";
import { DuplicateRequestIdError, pgErrorOf, translateDbError } from "../errors";
import { type AttemptKind, approvals, executionAttempts, systemFlags } from "../schema/index";
import type { RepoCtx } from "./context";
import { type ExecutionAttempt, toAttempt } from "./execution-attempts";

export interface Approval {
  readonly id: ApprovalId;
  readonly businessId: BusinessId;
  readonly kind: ApprovalKind;
  readonly subjectRef: string;
  readonly hash: string;
  readonly nonce: string;
  readonly approverId: UserId;
  readonly status: ApprovalStatus;
  readonly endReason: ApprovalEndReason | null;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly shownSnapshot: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type Row = typeof approvals.$inferSelect;
const toApproval = (r: Row): Approval => ({
  id: r.id as ApprovalId,
  businessId: r.businessId as BusinessId,
  kind: r.kind as ApprovalKind,
  subjectRef: r.subjectRef,
  hash: r.hash,
  nonce: r.nonce,
  approverId: r.approverId as UserId,
  status: r.status as ApprovalStatus,
  endReason: r.endReason as ApprovalEndReason | null,
  expiresAt: r.expiresAt,
  consumedAt: r.consumedAt,
  shownSnapshot: r.shownSnapshot,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** What a reader sees: an APPROVED approval past its expiry reads EXPIRED even before a sweep ran. */
export function effectiveApprovalStatus(a: Approval, now: Date): ApprovalStatus {
  return (a.status === "APPROVED" || a.status === "PENDING") &&
    a.expiresAt.getTime() <= now.getTime()
    ? "EXPIRED"
    : a.status;
}

export interface NewApproval {
  id?: ApprovalId;
  kind: ApprovalKind;
  subjectRef: string;
  hash: string;
  nonce: string;
  approverId: UserId;
  expiresAt: Date;
  shownSnapshot: unknown;
}

/**
 * Stores an APPROVED approval. Any live approval for the same subject is ended first (REJECTED,
 * SUPERSEDED): an edit or a second approval never leaves two valid ones. Call inside a transaction.
 */
export async function createApproval(ctx: RepoCtx, input: NewApproval): Promise<Approval> {
  try {
    await ctx.db
      .update(approvals)
      .set({ status: "REJECTED", endReason: "SUPERSEDED", updatedAt: sql`now()` })
      .where(
        and(
          eq(approvals.businessId, ctx.businessId),
          eq(approvals.kind, input.kind),
          eq(approvals.subjectRef, input.subjectRef),
          inArray(approvals.status, ["PENDING", "APPROVED"]),
        ),
      );
    const [row] = await ctx.db
      .insert(approvals)
      .values({
        id: input.id ?? newApprovalId(),
        businessId: ctx.businessId,
        kind: input.kind,
        subjectRef: input.subjectRef,
        hash: input.hash,
        nonce: input.nonce,
        approverId: input.approverId,
        status: "APPROVED",
        expiresAt: input.expiresAt,
        shownSnapshot: input.shownSnapshot,
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return toApproval(row);
  } catch (error) {
    throw translateDbError(error);
  }
}

export async function getApproval(ctx: RepoCtx, id: ApprovalId): Promise<Approval | null> {
  const [row] = await ctx.db
    .select()
    .from(approvals)
    .where(and(eq(approvals.businessId, ctx.businessId), eq(approvals.id, id)));
  return row ? toApproval(row) : null;
}

/** The approval of a subject that is still live (PENDING or APPROVED), if any. */
export async function getLiveApprovalForSubject(
  ctx: RepoCtx,
  kind: ApprovalKind,
  subjectRef: string,
): Promise<Approval | null> {
  const [row] = await ctx.db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.businessId, ctx.businessId),
        eq(approvals.kind, kind),
        eq(approvals.subjectRef, subjectRef),
        inArray(approvals.status, ["PENDING", "APPROVED"]),
      ),
    );
  return row ? toApproval(row) : null;
}

/** Every approval of a subject, newest first. */
export async function listApprovalsForSubject(
  ctx: RepoCtx,
  kind: ApprovalKind,
  subjectRef: string,
): Promise<Approval[]> {
  const rows = await ctx.db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.businessId, ctx.businessId),
        eq(approvals.kind, kind),
        eq(approvals.subjectRef, subjectRef),
      ),
    )
    .orderBy(desc(approvals.createdAt), desc(approvals.id));
  return rows.map(toApproval);
}

/**
 * Ends a live approval without consuming it (REJECTED by the user, or EXPIRED). Returns null when it
 * is not live (already consumed, rejected or expired) or is another business's.
 */
export async function endApproval(
  ctx: RepoCtx,
  id: ApprovalId,
  to: "REJECTED" | "EXPIRED",
  reason: ApprovalEndReason,
): Promise<Approval | null> {
  const [row] = await ctx.db
    .update(approvals)
    .set({ status: to, endReason: reason, updatedAt: sql`now()` })
    .where(
      and(
        eq(approvals.businessId, ctx.businessId),
        eq(approvals.id, id),
        inArray(approvals.status, ["PENDING", "APPROVED"]),
      ),
    )
    .returning();
  return row ? toApproval(row) : null;
}

export type ConsumeRefusal =
  | "NOT_FOUND"
  | "NOT_APPROVED"
  | "EXPIRED"
  | "HASH_MISMATCH"
  | "KILL_SWITCH";

export type ConsumeResult =
  | { outcome: "consumed"; approval: Approval; attempt: ExecutionAttempt }
  | { outcome: "refused"; reason: ConsumeRefusal };

const ATTEMPT_KIND_OF: Record<ApprovalKind, AttemptKind> = {
  rfi_answer: "respond",
  conversion: "conversion",
  payout: "transfer",
};

export interface ConsumeInput {
  approvalId: ApprovalId;
  /** The hash the caller was told to execute (the job payload). Must equal the approval's hash. */
  expectedHash: string;
  /** Minted once per intent; a test passes a taken id to prove the transaction rolls back. */
  requestId?: RequestId;
  /**
   * Runs in the same transaction after the attempt is inserted (the RFI moves to ANSWER_SUBMITTING and
   * the audit rows are written here). Anything it throws rolls the consume back.
   */
  inTransaction?: (tx: RepoCtx, approval: Approval, attempt: ExecutionAttempt) => Promise<void>;
}

/**
 * The atomic consume (ADR 0008). With `execution_enabled=false` nothing is consumed: the approval is
 * ended EXPIRED / KILL_SWITCH (committed) and the result is a refusal. A concurrent second consumer
 * matches zero rows. A refusal writes no attempt and sends nothing.
 */
export async function consumeApproval(ctx: RepoCtx, input: ConsumeInput): Promise<ConsumeResult> {
  return withTransaction(ctx.db, async (tx) => {
    const rc: RepoCtx = { db: tx, businessId: ctx.businessId };
    const [flags] = await tx
      .select({ enabled: systemFlags.executionEnabled })
      .from(systemFlags)
      .where(eq(systemFlags.id, 1));
    if (!flags?.enabled) {
      // Fail closed: a missing flags row counts as off.
      await tx
        .update(approvals)
        .set({ status: "EXPIRED", endReason: "KILL_SWITCH", updatedAt: sql`now()` })
        .where(
          and(
            eq(approvals.businessId, ctx.businessId),
            eq(approvals.id, input.approvalId),
            inArray(approvals.status, ["PENDING", "APPROVED"]),
          ),
        );
      return { outcome: "refused", reason: "KILL_SWITCH" } as const;
    }

    const [row] = await tx
      .update(approvals)
      .set({ status: "CONSUMED", consumedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(approvals.businessId, ctx.businessId),
          eq(approvals.id, input.approvalId),
          eq(approvals.status, "APPROVED"),
          eq(approvals.hash, input.expectedHash),
          sql`${approvals.expiresAt} > now()`,
        ),
      )
      .returning();
    if (!row) {
      const [now] = await tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.businessId, ctx.businessId), eq(approvals.id, input.approvalId)));
      if (!now) return { outcome: "refused", reason: "NOT_FOUND" } as const;
      if (now.status !== "APPROVED") return { outcome: "refused", reason: "NOT_APPROVED" } as const;
      if (now.hash !== input.expectedHash) {
        return { outcome: "refused", reason: "HASH_MISMATCH" } as const;
      }
      return { outcome: "refused", reason: "EXPIRED" } as const;
    }
    const approval = toApproval(row);

    let attemptRow: typeof executionAttempts.$inferSelect | undefined;
    const requestId = input.requestId ?? newRequestId();
    try {
      [attemptRow] = await tx
        .insert(executionAttempts)
        .values({
          id: newAttemptId() as AttemptId,
          businessId: ctx.businessId,
          kind: ATTEMPT_KIND_OF[approval.kind],
          refId: approval.subjectRef,
          requestId,
          response: { approvalId: approval.id, hash: approval.hash },
        })
        .returning();
    } catch (error) {
      const pg = pgErrorOf(error);
      if (pg?.code === "23505" && pg.constraint === "execution_attempts_request_id_key") {
        throw new DuplicateRequestIdError(requestId);
      }
      throw translateDbError(error);
    }
    if (!attemptRow) throw new Error("insert returned no row");
    const attempt = toAttempt(attemptRow);
    if (input.inTransaction) await input.inTransaction(rc, approval, attempt);
    return { outcome: "consumed", approval, attempt } as const;
  });
}
