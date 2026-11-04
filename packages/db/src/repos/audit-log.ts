import type { BusinessId } from "@carnet/domain";
import { desc, eq } from "drizzle-orm";
import { translateDbError } from "../errors";
import { auditLog } from "../schema/index";
import type { RepoCtx } from "./context";

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

/** Hashes (`prev_hash`, `hash`) are computed by the chain in M4-01; null until then. */
export async function appendAudit(ctx: RepoCtx, entry: NewAuditEntry): Promise<AuditEntry> {
  try {
    const [row] = await ctx.db
      .insert(auditLog)
      .values({
        businessId: ctx.businessId,
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        action: entry.action,
        subject: entry.subject,
        data: entry.data ?? {},
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return toEntry(row);
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
