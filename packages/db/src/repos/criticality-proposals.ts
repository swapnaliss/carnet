// Criticality proposals (M3-01): the model's reading of a contract, stored with the verifier's verdict.
// The worker inserts a proposal (idempotent per job); the API reads it. A proposal never changes an
// obligation's `criticality`; only its `status` moves, and only in obligation-confirm.ts.
import {
  type BusinessId,
  type CriticalityProposalStatus,
  type CriticalityRejectReason,
  type CriticalityValue,
  isCriticalityValue,
} from "@carnet/domain";
import { and, desc, eq } from "drizzle-orm";
import { translateDbError } from "../errors";
import { criticalityProposals } from "../schema/index";
import type { RepoCtx } from "./context";

export interface InjectionFlagRecord {
  readonly kind: string;
  readonly rule: string;
  readonly match: string;
}

export interface CriticalityProposal {
  readonly id: string;
  readonly businessId: BusinessId;
  readonly obligationId: string;
  readonly proposalKey: string;
  readonly proposedCriticality: CriticalityValue | null;
  readonly rationale: string;
  readonly quote: string;
  readonly quotePage: number | null;
  readonly documentId: string;
  readonly agentRunId: string | null;
  readonly verifierResult: "VERIFIED" | "REJECTED";
  readonly verifierReason: CriticalityRejectReason | null;
  readonly status: CriticalityProposalStatus;
  readonly injectionSuspected: boolean;
  readonly injectionFlags: readonly InjectionFlagRecord[];
  readonly promptVersion: string | null;
  readonly model: string | null;
  readonly createdAt: Date;
}

type Row = typeof criticalityProposals.$inferSelect;

export function toProposal(r: Row): CriticalityProposal {
  if (r.proposedCriticality !== null && !isCriticalityValue(r.proposedCriticality)) {
    throw new Error(`proposed criticality out of range in database: ${r.proposedCriticality}`);
  }
  return {
    id: r.id,
    businessId: r.businessId as BusinessId,
    obligationId: r.obligationId,
    proposalKey: r.proposalKey,
    proposedCriticality: r.proposedCriticality,
    rationale: r.rationale,
    quote: r.quote,
    quotePage: r.quotePage,
    documentId: r.documentId,
    agentRunId: r.agentRunId,
    verifierResult: r.verifierResult as CriticalityProposal["verifierResult"], // CHECK constraint
    verifierReason: r.verifierReason as CriticalityRejectReason | null,
    status: r.status as CriticalityProposalStatus, // CHECK constraint
    injectionSuspected: r.injectionSuspected,
    injectionFlags: r.injectionFlags as InjectionFlagRecord[],
    promptVersion: r.promptVersion,
    model: r.model,
    createdAt: r.createdAt,
  };
}

export interface NewCriticalityProposal {
  readonly obligationId: string;
  readonly documentId: string;
  /** The job id: one job stores at most one proposal. */
  readonly proposalKey: string;
  readonly agentRunId?: string | null;
  readonly proposedCriticality?: CriticalityValue | null;
  readonly rationale?: string;
  readonly quote?: string;
  readonly quotePage?: number | null;
  /** REJECTED must carry a reason; VERIFIED must carry a value, a quote and a page. */
  readonly verifierResult: "VERIFIED" | "REJECTED";
  readonly verifierReason?: CriticalityRejectReason | null;
  readonly injectionSuspected?: boolean;
  readonly injectionFlags?: readonly InjectionFlagRecord[];
  readonly promptVersion?: string | null;
  readonly model?: string | null;
}

/**
 * Inserts the proposal, or returns the one this key already stored (`inserted: false`). The status is
 * derived here: a rejected proposal is `REJECTED`, a verified one starts as `PROPOSED`.
 */
export async function insertCriticalityProposal(
  ctx: RepoCtx,
  input: NewCriticalityProposal,
): Promise<{ proposal: CriticalityProposal; inserted: boolean }> {
  try {
    const [row] = await ctx.db
      .insert(criticalityProposals)
      .values({
        businessId: ctx.businessId,
        obligationId: input.obligationId,
        documentId: input.documentId,
        proposalKey: input.proposalKey,
        agentRunId: input.agentRunId ?? null,
        proposedCriticality: input.proposedCriticality ?? null,
        rationale: input.rationale ?? "",
        quote: input.quote ?? "",
        quotePage: input.quotePage ?? null,
        verifierResult: input.verifierResult,
        verifierReason: input.verifierReason ?? null,
        status: input.verifierResult === "REJECTED" ? "REJECTED" : "PROPOSED",
        injectionSuspected: input.injectionSuspected ?? false,
        injectionFlags: [...(input.injectionFlags ?? [])],
        promptVersion: input.promptVersion ?? null,
        model: input.model ?? null,
      })
      .onConflictDoNothing({
        target: [
          criticalityProposals.businessId,
          criticalityProposals.obligationId,
          criticalityProposals.proposalKey,
        ],
      })
      .returning();
    if (row) return { proposal: toProposal(row), inserted: true };
    const [existing] = await ctx.db
      .select()
      .from(criticalityProposals)
      .where(
        and(
          eq(criticalityProposals.businessId, ctx.businessId),
          eq(criticalityProposals.obligationId, input.obligationId),
          eq(criticalityProposals.proposalKey, input.proposalKey),
        ),
      );
    if (!existing) throw new Error("criticality proposal conflict without a row");
    return { proposal: toProposal(existing), inserted: false };
  } catch (error) {
    throw translateDbError(error);
  }
}

export async function getCriticalityProposal(
  ctx: RepoCtx,
  id: string,
): Promise<CriticalityProposal | null> {
  const [row] = await ctx.db
    .select()
    .from(criticalityProposals)
    .where(
      and(eq(criticalityProposals.businessId, ctx.businessId), eq(criticalityProposals.id, id)),
    );
  return row ? toProposal(row) : null;
}

/** The newest proposal for the obligation, or null. */
export async function getLatestCriticalityProposal(
  ctx: RepoCtx,
  obligationId: string,
): Promise<CriticalityProposal | null> {
  const [row] = await ctx.db
    .select()
    .from(criticalityProposals)
    .where(
      and(
        eq(criticalityProposals.businessId, ctx.businessId),
        eq(criticalityProposals.obligationId, obligationId),
      ),
    )
    .orderBy(desc(criticalityProposals.createdAt), desc(criticalityProposals.id))
    .limit(1);
  return row ? toProposal(row) : null;
}
