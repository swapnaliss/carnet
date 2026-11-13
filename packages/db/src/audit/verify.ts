// Chain verification (M4-01). Recomputes every hash and link in id order. Rows written before the
// chain existed carry no hash; they are "legacy" and only allowed before the first hashed row.
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { Db } from "../client";
import { auditChainHead, auditChainStatus, auditLog } from "../schema/index";
import { computeAuditHash, GENESIS_HASH } from "./hash";

export type AuditChainReason =
  | "HASH_MISMATCH"
  | "LINK_MISMATCH"
  | "GAP"
  | "GENESIS_MISMATCH"
  | "HEAD_MISMATCH";

export interface AuditChainResult {
  readonly ok: boolean;
  /** Hashed rows examined. */
  readonly checked: number;
  readonly firstBadId?: bigint;
  readonly reason?: AuditChainReason;
  /** Hash of the last hashed row examined. */
  readonly headHash: string | null;
}

const BATCH = 1000;

/**
 * `from`/`to` limit the id range; a range that does not start at the chain's first row checks links
 * from the row before `from` instead of the genesis, and the stored-head check only runs for a
 * full-range verification.
 */
export async function verifyAuditChain(
  db: Db,
  range: { from?: bigint; to?: bigint } = {},
): Promise<AuditChainResult> {
  const full = range.from === undefined && range.to === undefined;
  let expectedPrev: string | null = null; // null = not yet seen a hashed row
  let seenHashed = false;
  let checked = 0;
  let lastHash: string | null = null;

  if (range.from !== undefined) {
    const [prev] = await db
      .select({ hash: auditLog.hash })
      .from(auditLog)
      .where(sql`${auditLog.id} < ${range.from} AND ${auditLog.hash} IS NOT NULL`)
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1);
    if (prev?.hash) {
      expectedPrev = prev.hash;
      seenHashed = true;
    }
  }

  let cursor = range.from !== undefined ? range.from - 1n : -1n;
  for (;;) {
    const conds = [sql`${auditLog.id} > ${cursor}`];
    if (range.to !== undefined) conds.push(lte(auditLog.id, range.to));
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(...conds))
      .orderBy(asc(auditLog.id))
      .limit(BATCH);
    if (rows.length === 0) break;
    for (const r of rows) {
      cursor = r.id;
      if (r.hash === null) {
        if (seenHashed) return bad(r.id, "HASH_MISMATCH", checked, lastHash);
        continue; // legacy row from before the chain
      }
      const wantPrev: string = expectedPrev ?? GENESIS_HASH;
      if (r.prevHash !== wantPrev) {
        const reason: AuditChainReason = seenHashed ? "LINK_MISMATCH" : "GENESIS_MISMATCH";
        // A range that starts mid-chain has no genesis to compare with, only the row before.
        return bad(
          r.id,
          range.from !== undefined && !seenHashed ? "LINK_MISMATCH" : reason,
          checked,
          lastHash,
        );
      }
      const recomputed = computeAuditHash({
        prevHash: r.prevHash,
        at: r.at,
        actorType: r.actorType,
        actorId: r.actorId,
        action: r.action,
        subject: r.subject,
        data: r.data,
      });
      if (recomputed !== r.hash) return bad(r.id, "HASH_MISMATCH", checked, lastHash);
      seenHashed = true;
      expectedPrev = r.hash;
      lastHash = r.hash;
      checked += 1;
    }
  }

  if (full) {
    const [head] = await db.select().from(auditChainHead).where(eq(auditChainHead.id, 1));
    if (head) {
      if ((head.lastHash ?? null) !== lastHash) {
        return bad(head.lastId ?? 0n, "HEAD_MISMATCH", checked, lastHash);
      }
      if (head.rowCount !== BigInt(checked))
        return bad(head.lastId ?? 0n, "GAP", checked, lastHash);
    }
  }
  return { ok: true, checked, headHash: lastHash };
}

function bad(
  id: bigint,
  reason: AuditChainReason,
  checked: number,
  headHash: string | null,
): AuditChainResult {
  return { ok: false, checked, firstBadId: id, reason, headHash };
}

export interface AuditChainStatus extends AuditChainResult {
  readonly verifiedAt: Date;
}

/** Stores the latest result for /ops (a single row, replaced each run). */
export async function storeAuditChainStatus(db: Db, r: AuditChainResult): Promise<void> {
  const values = {
    ok: r.ok,
    checked: r.checked,
    firstBadId: r.firstBadId ?? null,
    reason: r.reason ?? null,
    headHash: r.headHash,
    verifiedAt: new Date(),
  };
  await db
    .insert(auditChainStatus)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: auditChainStatus.id, set: values });
}

export async function readAuditChainStatus(db: Db): Promise<AuditChainStatus | null> {
  const [row] = await db.select().from(auditChainStatus).where(eq(auditChainStatus.id, 1));
  if (!row) return null;
  return {
    ok: row.ok,
    checked: row.checked,
    ...(row.firstBadId === null ? {} : { firstBadId: row.firstBadId }),
    ...(row.reason === null ? {} : { reason: row.reason as AuditChainReason }),
    headHash: row.headHash,
    verifiedAt: row.verifiedAt ?? new Date(0),
  };
}

/** Verify now and store the result. */
export async function verifyAndStoreAuditChain(db: Db): Promise<AuditChainResult> {
  const result = await verifyAuditChain(db);
  await storeAuditChainStatus(db, result);
  return result;
}
