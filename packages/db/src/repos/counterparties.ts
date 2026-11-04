import { type BusinessId, type CounterpartyId, newCounterpartyId } from "@carnet/domain";
import { and, asc, eq } from "drizzle-orm";
import { translateDbError } from "../errors";
import { counterparties } from "../schema/index";
import type { RepoCtx } from "./context";

export interface Counterparty {
  readonly id: CounterpartyId;
  readonly businessId: BusinessId;
  readonly name: string;
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
  /** Airwallex beneficiary id, once created. */
  readonly beneficiaryId: string | null;
  readonly accountFingerprint: string | null;
  readonly createdAt: Date;
}

type Row = typeof counterparties.$inferSelect;
const toCounterparty = (r: Row): Counterparty => ({
  id: r.id as CounterpartyId,
  businessId: r.businessId as BusinessId,
  name: r.name,
  country: r.country,
  beneficiaryId: r.beneficiaryId,
  accountFingerprint: r.accountFingerprint,
  createdAt: r.createdAt,
});

export interface NewCounterparty {
  id?: CounterpartyId;
  name: string;
  country: string;
  beneficiaryId?: string | null;
  accountFingerprint?: string | null;
}

export async function createCounterparty(
  ctx: RepoCtx,
  input: NewCounterparty,
): Promise<Counterparty> {
  try {
    const [row] = await ctx.db
      .insert(counterparties)
      .values({
        id: input.id ?? newCounterpartyId(),
        businessId: ctx.businessId,
        name: input.name,
        country: input.country,
        beneficiaryId: input.beneficiaryId ?? null,
        accountFingerprint: input.accountFingerprint ?? null,
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return toCounterparty(row);
  } catch (error) {
    throw translateDbError(error);
  }
}

export async function getCounterparty(
  ctx: RepoCtx,
  id: CounterpartyId,
): Promise<Counterparty | null> {
  const [row] = await ctx.db
    .select()
    .from(counterparties)
    .where(and(eq(counterparties.businessId, ctx.businessId), eq(counterparties.id, id)));
  return row ? toCounterparty(row) : null;
}

export async function listCounterparties(ctx: RepoCtx): Promise<Counterparty[]> {
  const rows = await ctx.db
    .select()
    .from(counterparties)
    .where(eq(counterparties.businessId, ctx.businessId))
    .orderBy(asc(counterparties.name), asc(counterparties.id));
  return rows.map(toCounterparty);
}

export interface CounterpartyPatch {
  name?: string;
  country?: string;
  beneficiaryId?: string | null;
  accountFingerprint?: string | null;
}

export async function updateCounterparty(
  ctx: RepoCtx,
  id: CounterpartyId,
  patch: CounterpartyPatch,
): Promise<Counterparty | null> {
  const [row] = await ctx.db
    .update(counterparties)
    .set(patch)
    .where(and(eq(counterparties.businessId, ctx.businessId), eq(counterparties.id, id)))
    .returning();
  return row ? toCounterparty(row) : null;
}

/** Returns true when a row of this business was deleted. */
export async function deleteCounterparty(ctx: RepoCtx, id: CounterpartyId): Promise<boolean> {
  try {
    const rows = await ctx.db
      .delete(counterparties)
      .where(and(eq(counterparties.businessId, ctx.businessId), eq(counterparties.id, id)))
      .returning({ id: counterparties.id });
    return rows.length > 0;
  } catch (error) {
    throw translateDbError(error);
  }
}
