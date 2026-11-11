// Obligations, tenant side (M3-01): create, list, get. Every function takes `ctx` first and scopes by
// `ctx.businessId`.
//
// Nothing in this module writes `criticality`: the confirmed value is set by `confirmCriticality` in
// obligation-confirm.ts and nowhere else (ADR 0011). The worker and the agent reach obligations only
// through these reads and the proposals repository.
import {
  type BusinessId,
  type CriticalityValue,
  type Currency,
  isCriticalityValue,
  type PlanningCriticality,
  planningCriticality,
} from "@carnet/domain";
import { and, asc, eq } from "drizzle-orm";
import { translateDbError } from "../errors";
import { obligations } from "../schema/index";
import { currencyFromDb, type RepoCtx } from "./context";

export interface Obligation {
  readonly id: string;
  readonly businessId: BusinessId;
  readonly counterpartyId: string;
  readonly amountMinor: bigint;
  readonly currency: Currency;
  readonly dueAt: Date;
  /** The confirmed value; null until a person confirms it. */
  readonly criticality: CriticalityValue | null;
  readonly criticalityConfirmedBy: string | null;
  readonly criticalityConfirmedAt: Date | null;
  readonly criticalityConfirmedProposalId: string | null;
  readonly paymentId: string | null;
  readonly sourceDocumentId: string | null;
  readonly createdAt: Date;
}

type Row = typeof obligations.$inferSelect;

export function toObligation(r: Row): Obligation {
  if (r.criticality !== null && !isCriticalityValue(r.criticality)) {
    throw new Error(`criticality out of range in database: ${r.criticality}`);
  }
  return {
    id: r.id,
    businessId: r.businessId as BusinessId,
    counterpartyId: r.counterpartyId,
    amountMinor: r.amountMinor,
    currency: currencyFromDb(r.currency),
    dueAt: r.dueAt,
    criticality: r.criticality,
    criticalityConfirmedBy: r.criticalityConfirmedBy,
    criticalityConfirmedAt: r.criticalityConfirmedAt,
    criticalityConfirmedProposalId: r.criticalityConfirmedProposalId,
    paymentId: r.paymentId,
    sourceDocumentId: r.sourceDocumentId,
    createdAt: r.createdAt,
  };
}

/** What the planner may use for this obligation: the confirmed value or `UNCONFIRMED`. */
export function planningCriticalityOf(o: Obligation): PlanningCriticality {
  return planningCriticality(o);
}

export interface NewObligation {
  readonly counterpartyId: string;
  readonly amountMinor: bigint;
  readonly currency: Currency;
  readonly dueAt: Date;
  readonly paymentId?: string | null;
  readonly sourceDocumentId?: string | null;
}

/** Throws ForeignKeyViolationError when the counterparty or the document is not in this business. */
export async function createObligation(ctx: RepoCtx, input: NewObligation): Promise<Obligation> {
  try {
    const [row] = await ctx.db
      .insert(obligations)
      .values({
        businessId: ctx.businessId,
        counterpartyId: input.counterpartyId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        dueAt: input.dueAt,
        paymentId: input.paymentId ?? null,
        sourceDocumentId: input.sourceDocumentId ?? null,
      })
      .returning();
    if (!row) throw new Error("obligations insert returned no row");
    return toObligation(row);
  } catch (error) {
    throw translateDbError(error);
  }
}

export async function getObligation(ctx: RepoCtx, id: string): Promise<Obligation | null> {
  const [row] = await ctx.db
    .select()
    .from(obligations)
    .where(and(eq(obligations.businessId, ctx.businessId), eq(obligations.id, id)));
  return row ? toObligation(row) : null;
}

/** Soonest due first. */
export async function listObligations(ctx: RepoCtx, limit = 100): Promise<Obligation[]> {
  const rows = await ctx.db
    .select()
    .from(obligations)
    .where(eq(obligations.businessId, ctx.businessId))
    .orderBy(asc(obligations.dueAt), asc(obligations.id))
    .limit(limit);
  return rows.map(toObligation);
}
