import type { BusinessId } from "@carnet/domain";
import { eq } from "drizzle-orm";
import { businesses } from "../schema/index";
import type { RepoCtx } from "./context";

export interface Business {
  readonly id: BusinessId;
  readonly name: string;
  readonly timezone: string;
  readonly policyVersion: number;
  readonly airwallexAccountId: string | null;
  /** `businesses.evidence_policy`; read it with `parseEvidencePolicy` (M2-03). */
  readonly evidencePolicy: unknown;
  readonly createdAt: Date;
}

type Row = typeof businesses.$inferSelect;
const toBusiness = (r: Row): Business => ({
  id: r.id as BusinessId,
  name: r.name,
  timezone: r.timezone,
  policyVersion: r.policyVersion,
  airwallexAccountId: r.airwallexAccountId,
  evidencePolicy: r.evidencePolicy,
  createdAt: r.createdAt,
});

/** The caller's own business. */
export async function getBusiness(ctx: RepoCtx): Promise<Business | null> {
  const [row] = await ctx.db.select().from(businesses).where(eq(businesses.id, ctx.businessId));
  return row ? toBusiness(row) : null;
}

export interface BusinessPatch {
  name?: string;
  timezone?: string;
  policyVersion?: number;
  airwallexAccountId?: string | null;
}

export async function updateBusiness(ctx: RepoCtx, patch: BusinessPatch): Promise<Business | null> {
  const [row] = await ctx.db
    .update(businesses)
    .set(patch)
    .where(eq(businesses.id, ctx.businessId))
    .returning();
  return row ? toBusiness(row) : null;
}
