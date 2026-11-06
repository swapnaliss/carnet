// RFI tenant attribution and the scheduled expiry flag (M2-04). A webhook or a poll names an Airwallex
// RFI, not a tenant, so the worker first finds which business owns it. These functions take `db` and
// return business ids; the caller continues through a tenant context (`repoCtx(db, businessId)`).
// Nothing here is reachable from a request.
//
// Attribution order (first hit wins):
//   1. the business already holding this Airwallex RFI id
//   2. the business whose `airwallex_account_id` equals the RFI's `account_id`
//   3. the one business owning every payment its TRANSFER sources map to
//   4. the only business in the deployment (launch scale: one business per deployment)
// Otherwise the RFI is unattributed: logged by the caller and not stored.
import type { BusinessId } from "@carnet/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client";
import { businesses, payments, rfis } from "../schema/index";

export type RfiAttribution =
  | { readonly businessId: BusinessId; readonly by: "existing" | "account" | "transfer" | "sole" }
  | { readonly businessId: null; readonly by: "none" };

export async function attributeRfi(
  db: Db,
  input: { airwallexRfiId: string; accountId: string | null; transferIds: string[] },
): Promise<RfiAttribution> {
  const [existing] = await db
    .select({ businessId: rfis.businessId })
    .from(rfis)
    .where(eq(rfis.airwallexRfiId, input.airwallexRfiId))
    .limit(1);
  if (existing) return { businessId: existing.businessId as BusinessId, by: "existing" };

  if (input.accountId) {
    const [byAccount] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.airwallexAccountId, input.accountId));
    if (byAccount) return { businessId: byAccount.id as BusinessId, by: "account" };
  }

  if (input.transferIds.length > 0) {
    const owners = await db
      .selectDistinct({ businessId: payments.businessId })
      .from(payments)
      .where(inArray(payments.transferId, input.transferIds));
    const [only] = owners;
    if (owners.length === 1 && only) {
      return { businessId: only.businessId as BusinessId, by: "transfer" };
    }
  }

  const sole = await db.select({ id: businesses.id }).from(businesses).limit(2);
  const [first] = sole;
  if (sole.length === 1 && first) return { businessId: first.id as BusinessId, by: "sole" };
  return { businessId: null, by: "none" };
}

/**
 * The scheduled expiry check: sets `expiring_soon` on RFIs still waiting for an answer whose
 * `expires_at` is within `windowMs` (or past), and clears it elsewhere. Returns the rows changed.
 * Mirrors `rfiExpiringSoon` in @carnet/domain.
 */
export async function refreshRfiExpiringSoon(db: Db, now: Date, windowMs: number): Promise<number> {
  const cutoff = new Date(now.getTime() + windowMs);
  const soon = sql`(${rfis.expiresAt} IS NOT NULL AND ${rfis.expiresAt} <= ${cutoff}
    AND ${rfis.state} NOT IN ('ANSWERED', 'CLOSED', 'EXPIRED'))`;
  const set = await db
    .update(rfis)
    .set({ expiringSoon: true })
    .where(and(soon, eq(rfis.expiringSoon, false)))
    .returning({ id: rfis.id });
  const cleared = await db
    .update(rfis)
    .set({ expiringSoon: false })
    .where(and(eq(rfis.expiringSoon, true), sql`NOT (${soon})`))
    .returning({ id: rfis.id });
  return set.length + cleared.length;
}
