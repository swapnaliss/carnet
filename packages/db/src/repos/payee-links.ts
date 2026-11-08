// Payee status links (M3-06), tenant side: create, list, revoke. Every function takes `ctx` first and
// scopes by `ctx.businessId`; a link for another business's payment cannot be created. The raw token
// never reaches this module, only its SHA-256 (64 hex characters). The public lookup by token hash is
// in payee-link-lookup.ts (a system module: the caller has no tenant context).
import {
  type BusinessId,
  type DisclosureLevel,
  isDisclosureLevel,
  type PaymentId,
  type UserId,
} from "@carnet/domain";
import { and, asc, eq, isNull } from "drizzle-orm";
import { translateDbError } from "../errors";
import { payeeLinks, payments } from "../schema/index";
import type { RepoCtx } from "./context";

export interface PayeeLink {
  readonly id: string;
  readonly paymentId: PaymentId;
  readonly businessId: BusinessId;
  /** First 6 hex characters of the token hash: the only part that may reach a log or a response. */
  readonly tokenHashPrefix: string;
  readonly expiresAt: Date;
  readonly disclosureLevel: DisclosureLevel;
  readonly revokedAt: Date | null;
  readonly createdBy: UserId;
  readonly createdAt: Date;
  readonly lastViewedAt: Date | null;
}

type Row = typeof payeeLinks.$inferSelect;
function toPayeeLink(r: Row): PayeeLink {
  if (!isDisclosureLevel(r.disclosureLevel)) {
    throw new Error(`unknown disclosure level in database: ${r.disclosureLevel}`);
  }
  return {
    id: r.id,
    paymentId: r.paymentId as PaymentId,
    businessId: r.businessId as BusinessId,
    tokenHashPrefix: r.tokenHash.slice(0, 6),
    expiresAt: r.expiresAt,
    disclosureLevel: r.disclosureLevel,
    revokedAt: r.revokedAt,
    createdBy: r.createdBy as UserId,
    createdAt: r.createdAt,
    lastViewedAt: r.lastViewedAt,
  };
}

export interface NewPayeeLink {
  paymentId: PaymentId;
  /** SHA-256 of the token, 64 lower-case hex characters. */
  tokenHash: string;
  expiresAt: Date;
  disclosureLevel: DisclosureLevel;
  createdBy: UserId;
}

/** Returns null when the payment is not in this business (the caller answers 404). */
export async function createPayeeLink(
  ctx: RepoCtx,
  input: NewPayeeLink,
): Promise<PayeeLink | null> {
  try {
    const [payment] = await ctx.db
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.businessId, ctx.businessId), eq(payments.id, input.paymentId)));
    if (!payment) return null;
    const [row] = await ctx.db
      .insert(payeeLinks)
      .values({
        paymentId: input.paymentId,
        businessId: ctx.businessId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        disclosureLevel: input.disclosureLevel,
        createdBy: input.createdBy,
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return toPayeeLink(row);
  } catch (error) {
    throw translateDbError(error);
  }
}

/** Oldest first. */
export async function listPayeeLinks(ctx: RepoCtx, paymentId: PaymentId): Promise<PayeeLink[]> {
  const rows = await ctx.db
    .select()
    .from(payeeLinks)
    .where(and(eq(payeeLinks.businessId, ctx.businessId), eq(payeeLinks.paymentId, paymentId)))
    .orderBy(asc(payeeLinks.createdAt), asc(payeeLinks.id));
  return rows.map(toPayeeLink);
}

/**
 * Revokes a link (idempotent: an already revoked link keeps its first `revokedAt`). Returns null when
 * the link is not on this business's payment.
 */
export async function revokePayeeLink(
  ctx: RepoCtx,
  paymentId: PaymentId,
  linkId: string,
  now: Date = new Date(),
): Promise<PayeeLink | null> {
  const scope = and(
    eq(payeeLinks.businessId, ctx.businessId),
    eq(payeeLinks.paymentId, paymentId),
    eq(payeeLinks.id, linkId),
  );
  const [updated] = await ctx.db
    .update(payeeLinks)
    .set({ revokedAt: now })
    .where(and(scope, isNull(payeeLinks.revokedAt)))
    .returning();
  if (updated) return toPayeeLink(updated);
  const [existing] = await ctx.db.select().from(payeeLinks).where(scope);
  return existing ? toPayeeLink(existing) : null;
}
