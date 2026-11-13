import type { BusinessId } from "@carnet/domain";
import { desc, eq, sql } from "drizzle-orm";
import { translateDbError } from "../errors";
import type { RepoCtx } from "../repos/context";
import { auditChainHead, auditLog } from "../schema/index";
import { computeAuditHash, GENESIS_HASH } from "./hash";

/** Append-only: there is no update or delete, and the app role cannot do either (ADR 0013). */
export interface AuditEntry {
  readonly id: bigint;
  readonly businessId: BusinessId | null;
  readonly prevHash: string | null;
  readonly hash: string | null;
  readonly at: Date;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly subject: string;
  readonly data: unknown;
}

type Row = typeof auditLog.$inferSelect;
const toEntry = (r: Row): AuditEntry => ({
  id: r.id,
  businessId: r.businessId as BusinessId | null,
  prevHash: r.prevHash,
  hash: r.hash,
  at: r.at,
  actorType: r.actorType,
  actorId: r.actorId,
  action: r.action,
  subject: r.subject,
  data: r.data,
});

export interface NewAuditEntry {
  actorType: string;
  actorId?: string | null;
  action: string;
  subject: string;
  data?: unknown;
}

/**
 * The ONLY write path to audit_log (M4-01). Runs in the caller's transaction (a nested call is a
 * savepoint), takes the chain head row FOR UPDATE so concurrent appends serialise and cannot fork the
 * chain, then writes the row with `prev_hash` and `hash` and advances the head. A rollback leaves no
 * row and the head unchanged. Model-driven steps pass `actorType: "agent"` and the agent's own id.
 */
export async function appendAudit(ctx: RepoCtx, entry: NewAuditEntry): Promise<AuditEntry> {
  try {
    return await ctx.db.transaction(async (tx) => {
      const [head] = await tx
        .select()
        .from(auditChainHead)
        .where(eq(auditChainHead.id, 1))
        .for("update");
      if (!head) throw new Error("audit_chain_head row is missing (migration 0017)");
      const at = new Date();
      const input = {
        prevHash: head.lastHash ?? GENESIS_HASH,
        at,
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        action: entry.action,
        subject: entry.subject,
        data: entry.data ?? {},
      };
      const hash = computeAuditHash(input);
      const [row] = await tx
        .insert(auditLog)
        .values({
          businessId: ctx.businessId,
          prevHash: input.prevHash,
          hash,
          at,
          actorType: input.actorType,
          actorId: input.actorId,
          action: input.action,
          subject: input.subject,
          data: input.data,
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      await tx
        .update(auditChainHead)
        .set({
          lastId: row.id,
          lastHash: hash,
          rowCount: sql`${auditChainHead.rowCount} + 1`,
          updatedAt: at,
        })
        .where(eq(auditChainHead.id, 1));
      return toEntry(row);
    });
  } catch (error) {
    throw translateDbError(error);
  }
}

/** Newest first. */
export async function listAudit(ctx: RepoCtx, limit = 100): Promise<AuditEntry[]> {
  const rows = await ctx.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.businessId, ctx.businessId))
    .orderBy(desc(auditLog.id))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map(toEntry);
}
