// RFIs and their questions (M2-04). Tenant repository: every function takes `ctx` first and scopes
// every statement by `ctx.businessId`. Questions are insert-only (earlier rounds never change).
import {
  type AirwallexRfiStatus,
  type BusinessId,
  isRfiState,
  type PaymentId,
  RFI_HOLDING_STATES,
  type RfiId,
  type RfiOrphanReason,
  type RfiState,
} from "@carnet/domain";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import { payments, rfiQuestions, rfis } from "../schema/index";
import type { RepoCtx } from "./context";

export interface Rfi {
  readonly id: RfiId;
  readonly businessId: BusinessId;
  readonly airwallexRfiId: string;
  readonly type: string;
  readonly subType: string | null;
  readonly airwallexStatus: AirwallexRfiStatus;
  readonly airwallexUpdatedAt: Date;
  readonly airwallexAnsweredRequests: number;
  readonly state: RfiState;
  readonly round: number;
  readonly expiresAt: Date | null;
  readonly expiringSoon: boolean;
  readonly paymentId: PaymentId | null;
  readonly orphanReason: RfiOrphanReason | null;
  readonly linkedBy: "match" | "owner" | null;
  readonly sourceKey: string | null;
  readonly conflict: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LocalizedText {
  en: string | null;
  zh: string | null;
}

export interface RfiQuestionRow {
  readonly id: string;
  readonly rfiId: RfiId;
  readonly round: number;
  readonly airwallexQuestionId: string;
  readonly position: number;
  readonly title: LocalizedText;
  readonly description: LocalizedText;
  readonly comment: string | null;
  readonly answerType: string;
  readonly sources: { id: string; type: string }[];
  readonly reopened: boolean;
  readonly needsDrafting: boolean;
  readonly createdAt: Date;
}

type Row = typeof rfis.$inferSelect;
function toRfi(r: Row): Rfi {
  if (!isRfiState(r.state)) throw new Error(`unknown RFI state in database: ${r.state}`);
  return {
    id: r.id as RfiId,
    businessId: r.businessId as BusinessId,
    airwallexRfiId: r.airwallexRfiId,
    type: r.type,
    subType: r.subType,
    airwallexStatus: r.airwallexStatus as AirwallexRfiStatus,
    airwallexUpdatedAt: r.airwallexUpdatedAt,
    airwallexAnsweredRequests: r.airwallexAnsweredRequests,
    state: r.state,
    round: r.round,
    expiresAt: r.expiresAt,
    expiringSoon: r.expiringSoon,
    paymentId: r.paymentId as PaymentId | null,
    orphanReason: r.orphanReason as RfiOrphanReason | null,
    linkedBy: r.linkedBy as "match" | "owner" | null,
    sourceKey: r.sourceKey,
    conflict: r.conflict,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

type QRow = typeof rfiQuestions.$inferSelect;
const toQuestion = (r: QRow): RfiQuestionRow => ({
  id: r.id,
  rfiId: r.rfiId as RfiId,
  round: r.round,
  airwallexQuestionId: r.airwallexQuestionId,
  position: r.position,
  title: r.title,
  description: r.description,
  comment: r.comment,
  answerType: r.answerType,
  sources: r.sources,
  reopened: r.reopened,
  needsDrafting: r.needsDrafting,
  createdAt: r.createdAt,
});

export async function getRfi(ctx: RepoCtx, id: RfiId): Promise<Rfi | null> {
  const [row] = await ctx.db
    .select()
    .from(rfis)
    .where(and(eq(rfis.id, id), eq(rfis.businessId, ctx.businessId)));
  return row ? toRfi(row) : null;
}

/** Locks the row (call inside a transaction). Looks up by the Airwallex RFI id. */
export async function getRfiByAirwallexIdForUpdate(
  ctx: RepoCtx,
  airwallexRfiId: string,
): Promise<Rfi | null> {
  const [row] = await ctx.db
    .select()
    .from(rfis)
    .where(and(eq(rfis.airwallexRfiId, airwallexRfiId), eq(rfis.businessId, ctx.businessId)))
    .for("update");
  return row ? toRfi(row) : null;
}

/** Locks the row (call inside a transaction). */
export async function getRfiForUpdate(ctx: RepoCtx, id: RfiId): Promise<Rfi | null> {
  const [row] = await ctx.db
    .select()
    .from(rfis)
    .where(and(eq(rfis.id, id), eq(rfis.businessId, ctx.businessId)))
    .for("update");
  return row ? toRfi(row) : null;
}

export interface RfiFilter {
  /** true: only the orphan queue; false: only linked RFIs. */
  orphan?: boolean;
  states?: RfiState[];
  paymentId?: PaymentId;
  limit?: number;
}

/** Newest first. */
export async function listRfis(ctx: RepoCtx, filter: RfiFilter = {}): Promise<Rfi[]> {
  const conds = [eq(rfis.businessId, ctx.businessId)];
  if (filter.orphan === true) conds.push(isNull(rfis.paymentId));
  if (filter.orphan === false) conds.push(isNotNull(rfis.paymentId));
  if (filter.states && filter.states.length > 0) conds.push(inArray(rfis.state, filter.states));
  if (filter.paymentId) conds.push(eq(rfis.paymentId, filter.paymentId));
  const rows = await ctx.db
    .select()
    .from(rfis)
    .where(and(...conds))
    .orderBy(desc(rfis.createdAt), desc(rfis.id))
    .limit(Math.min(Math.max(filter.limit ?? 100, 1), 200));
  return rows.map(toRfi);
}

export interface NewRfi {
  airwallexRfiId: string;
  type: string;
  subType: string | null;
  airwallexStatus: AirwallexRfiStatus;
  airwallexUpdatedAt: Date;
  airwallexAnsweredRequests: number;
  state: RfiState;
  round: number;
  expiresAt: Date | null;
  paymentId: PaymentId | null;
  orphanReason: RfiOrphanReason | null;
  linkedBy: "match" | "owner" | null;
  sourceKey: string | null;
  conflict: boolean;
}

export async function insertRfi(ctx: RepoCtx, input: NewRfi): Promise<Rfi> {
  const [row] = await ctx.db
    .insert(rfis)
    .values({ ...input, businessId: ctx.businessId })
    .returning();
  if (!row) throw new Error("insert returned no row");
  return toRfi(row);
}

export type RfiPatch = Partial<Omit<NewRfi, "airwallexRfiId" | "type"> & { expiringSoon: boolean }>;

export async function updateRfi(ctx: RepoCtx, id: RfiId, patch: RfiPatch): Promise<Rfi | null> {
  const [row] = await ctx.db
    .update(rfis)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(rfis.id, id), eq(rfis.businessId, ctx.businessId)))
    .returning();
  return row ? toRfi(row) : null;
}

/**
 * Another open, non-conflict RFI of this business with the same type and source key (ADR 0018
 * amendment 1), or null.
 */
export async function findOpenRfiBySourceKey(
  ctx: RepoCtx,
  input: { type: string; sourceKey: string; excludeId?: RfiId },
): Promise<Rfi | null> {
  const conds = [
    eq(rfis.businessId, ctx.businessId),
    eq(rfis.type, input.type),
    eq(rfis.sourceKey, input.sourceKey),
    eq(rfis.conflict, false),
    notInArray(rfis.state, ["CLOSED", "EXPIRED"]),
  ];
  if (input.excludeId) conds.push(ne(rfis.id, input.excludeId));
  const [row] = await ctx.db
    .select()
    .from(rfis)
    .where(and(...conds))
    .limit(1);
  return row ? toRfi(row) : null;
}

export interface NewRfiQuestion {
  round: number;
  airwallexQuestionId: string;
  position: number;
  title: LocalizedText;
  description: LocalizedText;
  comment: string | null;
  answerType: string;
  sources: { id: string; type: string }[];
  reopened: boolean;
  needsDrafting: boolean;
}

/** Inserts questions that are not stored yet for their round; existing rows are never touched. */
export async function insertRfiQuestions(
  ctx: RepoCtx,
  rfiId: RfiId,
  questions: NewRfiQuestion[],
): Promise<number> {
  if (questions.length === 0) return 0;
  // The RFI must be this business's (never attach questions to another tenant's RFI).
  const owner = await getRfi(ctx, rfiId);
  if (!owner) return 0;
  const rows = await ctx.db
    .insert(rfiQuestions)
    .values(questions.map((q) => ({ ...q, rfiId, businessId: ctx.businessId })))
    .onConflictDoNothing({
      target: [rfiQuestions.rfiId, rfiQuestions.round, rfiQuestions.airwallexQuestionId],
    })
    .returning({ id: rfiQuestions.id });
  return rows.length;
}

/** Oldest round first, then insertion order. */
export async function listRfiQuestions(
  ctx: RepoCtx,
  rfiId: RfiId,
  round?: number,
): Promise<RfiQuestionRow[]> {
  const conds = [eq(rfiQuestions.businessId, ctx.businessId), eq(rfiQuestions.rfiId, rfiId)];
  if (round !== undefined) conds.push(eq(rfiQuestions.round, round));
  const rows = await ctx.db
    .select()
    .from(rfiQuestions)
    .where(and(...conds))
    .orderBy(asc(rfiQuestions.round), asc(rfiQuestions.position), asc(rfiQuestions.id));
  return rows.map(toQuestion);
}

/** This business's payments keyed by transfer id, for the transfer ids given (matching input). */
export async function paymentIdsByTransferIds(
  ctx: RepoCtx,
  transferIds: string[],
): Promise<Map<string, PaymentId>> {
  if (transferIds.length === 0) return new Map();
  const rows = await ctx.db
    .select({ id: payments.id, transferId: payments.transferId })
    .from(payments)
    .where(and(eq(payments.businessId, ctx.businessId), inArray(payments.transferId, transferIds)));
  return new Map(rows.map((r) => [r.transferId ?? "", r.id as PaymentId]));
}

/** True when an RFI linked to this payment is in a holding state (feeds `project(…, openRfi)`). */
export async function paymentHasHoldingRfi(ctx: RepoCtx, paymentId: PaymentId): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: rfis.id })
    .from(rfis)
    .where(
      and(
        eq(rfis.businessId, ctx.businessId),
        eq(rfis.paymentId, paymentId),
        inArray(rfis.state, [...RFI_HOLDING_STATES]),
      ),
    )
    .limit(1);
  return row !== undefined;
}
