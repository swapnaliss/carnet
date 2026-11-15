// Policies, auto-approvals and the single-use quote ledger (M3-03, ADR 0011). Tenant repository: `ctx`
// first, every statement scoped by `ctx.businessId`. Policy versions, auto-approvals and quote uses are
// append-only: the app role has no UPDATE or DELETE on them (migration 0016) and nothing here does either.
import {
  type Currency,
  makePolicy,
  type Policy,
  type PolicyContentInput,
  policyHash,
} from "@carnet/domain";
import { and, desc, eq, sql } from "drizzle-orm";
import { translateDbError } from "../errors";
import { autoApprovals, fxQuoteUses, policies } from "../schema/index";
import { currencyFromDb, type RepoCtx } from "./context";
import { enqueuePlanRerun } from "./outbox";

type PolicyRow = typeof policies.$inferSelect;

function toPolicy(row: PolicyRow): Policy {
  // `content` was validated when it was stored; makePolicy re-validates and the hash must still match.
  const policy = makePolicy(row.version, row.content as PolicyContentInput);
  if (policy.hash !== row.hash) {
    throw new Error(`policy ${row.version}: stored hash does not match its content`);
  }
  return policy;
}

/** The newest policy version of the business, or null when it has none (nothing is auto-approved). */
export async function getLatestPolicy(ctx: RepoCtx): Promise<Policy | null> {
  const [row] = await ctx.db
    .select()
    .from(policies)
    .where(eq(policies.businessId, ctx.businessId))
    .orderBy(desc(policies.version))
    .limit(1);
  return row ? toPolicy(row) : null;
}

export async function getPolicyVersion(ctx: RepoCtx, version: number): Promise<Policy | null> {
  const [row] = await ctx.db
    .select()
    .from(policies)
    .where(and(eq(policies.businessId, ctx.businessId), eq(policies.version, version)));
  return row ? toPolicy(row) : null;
}

/**
 * Stores `content` as the next version (1 for the first). An edit is a new row; the old rows are never
 * touched. Call inside a transaction: the advisory lock serialises concurrent edits of one business.
 */
export async function createPolicyVersion(
  ctx: RepoCtx,
  content: PolicyContentInput,
): Promise<Policy> {
  await ctx.db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`policy:${ctx.businessId}`}))`);
  const latest = await getLatestPolicy(ctx);
  const policy = makePolicy((latest?.version ?? 0) + 1, content);
  try {
    await ctx.db.insert(policies).values({
      businessId: ctx.businessId,
      version: policy.version,
      hash: policyHash(policy),
      content: {
        reserveFloor: policy.reserveFloor,
        perActionLimit: policy.perActionLimit,
        dailyCap: policy.dailyCap,
        slippageBps: policy.slippageBps,
        quoteFreshnessSeconds: policy.quoteFreshnessSeconds,
      },
    });
  } catch (error) {
    throw translateDbError(error);
  }
  // The policy (its reserve floor and auto-convert limits) is a planner input: re-plan in this transaction.
  await enqueuePlanRerun(ctx.db, {
    businessId: ctx.businessId,
    eventId: `policy:${policy.version}`,
    cause: "policy.changed",
  });
  return policy;
}

export interface AutoApprovalRecord {
  readonly id: string;
  readonly actionId: string;
  readonly policyVersion: number;
  readonly policyHash: string;
  readonly amountMinor: bigint;
  readonly currency: Currency;
  readonly dailyTotalAfterMinor: bigint;
  readonly createdAt: Date;
}

export interface NewAutoApproval {
  actionId: string;
  policyVersion: number;
  policyHash: string;
  amountMinor: bigint;
  currency: Currency;
  dailyTotalAfterMinor: bigint;
}

/** Records that a policy version allowed a conversion. The foreign key ties it to that version and hash. */
export async function insertAutoApproval(
  ctx: RepoCtx,
  input: NewAutoApproval,
): Promise<AutoApprovalRecord> {
  try {
    const [row] = await ctx.db
      .insert(autoApprovals)
      .values({ businessId: ctx.businessId, ...input })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return toAutoApproval(row);
  } catch (error) {
    throw translateDbError(error);
  }
}

const toAutoApproval = (r: typeof autoApprovals.$inferSelect): AutoApprovalRecord => ({
  id: r.id,
  actionId: r.actionId,
  policyVersion: r.policyVersion,
  policyHash: r.policyHash,
  amountMinor: r.amountMinor,
  currency: currencyFromDb(r.currency),
  dailyTotalAfterMinor: r.dailyTotalAfterMinor,
  createdAt: r.createdAt,
});

export async function getAutoApprovalForAction(
  ctx: RepoCtx,
  actionId: string,
): Promise<AutoApprovalRecord | null> {
  const [row] = await ctx.db
    .select()
    .from(autoApprovals)
    .where(and(eq(autoApprovals.businessId, ctx.businessId), eq(autoApprovals.actionId, actionId)));
  return row ? toAutoApproval(row) : null;
}

/**
 * The auto-approved sell amount in `currency` since the start of the business's current day (its
 * time zone; timestamps are stored in UTC). `now` is passed in so a test can fix the clock.
 */
export async function autoApprovedTotalToday(
  ctx: RepoCtx,
  currency: Currency,
  now: Date,
): Promise<bigint> {
  const result = await ctx.db.execute<{ total: string }>(sql`
    SELECT coalesce(sum(a.amount_minor), 0)::text AS total
    FROM auto_approvals a
    JOIN businesses b ON b.id = a.business_id
    WHERE a.business_id = ${ctx.businessId}
      AND a.currency = ${currency}
      AND a.created_at >= (date_trunc('day', ${now.toISOString()}::timestamptz AT TIME ZONE b.timezone) AT TIME ZONE b.timezone)
      AND a.created_at <= ${now.toISOString()}::timestamptz
  `);
  const row = result.rows[0];
  return BigInt(row?.total ?? "0");
}

/** Serialises auto-approvals of one business and currency (the daily cap is a read-then-insert). */
export async function lockAutoApprovals(ctx: RepoCtx, currency: Currency): Promise<void> {
  await ctx.db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`auto:${ctx.businessId}:${currency}`}))`,
  );
}

/**
 * Takes the single-use right to a quote: true the first time a quote id is claimed, false for every
 * later claim (Carnet's rule; the sandbox accepts a reused quote). Insert it in the attempt's transaction.
 */
export async function claimQuote(
  ctx: RepoCtx,
  input: { quoteId: string; actionId: string; attemptId: string },
): Promise<boolean> {
  const rows = await ctx.db
    .insert(fxQuoteUses)
    .values({ businessId: ctx.businessId, ...input })
    .onConflictDoNothing()
    .returning({ quoteId: fxQuoteUses.quoteId });
  return rows.length > 0;
}
