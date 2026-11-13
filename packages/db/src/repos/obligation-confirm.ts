// The one writer of an obligation's `criticality` (M3-01, ADR 0011). Only the confirm endpoint imports
// this module: the worker, the agent and the proposals repository do not (a test greps for it).
// The caller passes the authenticated user's id; the database also refuses a criticality without one.
import type { CriticalityValue } from "@carnet/domain";
import { and, eq } from "drizzle-orm";
import { translateDbError } from "../errors";
import { criticalityProposals, obligations } from "../schema/index";
import type { RepoCtx } from "./context";
import { type CriticalityProposal, toProposal } from "./criticality-proposals";
import { type Obligation, toObligation } from "./obligations";

/** The proposal named in a confirmation does not exist for this obligation. */
export class ProposalNotFoundError extends Error {
  override readonly name = "ProposalNotFoundError";
  constructor(proposalId: string) {
    super(`proposal ${proposalId} not found for this obligation`);
  }
}

export interface ConfirmCriticalityInput {
  readonly obligationId: string;
  readonly criticality: CriticalityValue;
  /** The authenticated human who confirms. */
  readonly userId: string;
  /** The proposal the owner saw, if any. */
  readonly proposalId?: string | null;
  readonly at: Date;
}

/**
 * Sets the confirmed criticality. Run it in a transaction with the audit entry. A `PROPOSED` proposal
 * becomes `CONFIRMED` when the owner chose its value and `OVERRIDDEN` when the owner chose another one.
 * Returns null when this business has no such obligation. Throws ProposalNotFoundError for a proposal
 * that is not this obligation's.
 */
export async function confirmCriticality(
  ctx: RepoCtx,
  input: ConfirmCriticalityInput,
): Promise<{ obligation: Obligation; proposal: CriticalityProposal | null } | null> {
  try {
    let proposal: CriticalityProposal | null = null;
    if (input.proposalId) {
      const [row] = await ctx.db
        .select()
        .from(criticalityProposals)
        .where(
          and(
            eq(criticalityProposals.businessId, ctx.businessId),
            eq(criticalityProposals.obligationId, input.obligationId),
            eq(criticalityProposals.id, input.proposalId),
          ),
        );
      if (!row) throw new ProposalNotFoundError(input.proposalId);
      proposal = toProposal(row);
    }
    const [updated] = await ctx.db
      .update(obligations)
      .set({
        criticality: input.criticality,
        criticalityConfirmedBy: input.userId,
        criticalityConfirmedAt: input.at,
        criticalityConfirmedProposalId: proposal?.id ?? null,
      })
      .where(
        and(eq(obligations.businessId, ctx.businessId), eq(obligations.id, input.obligationId)),
      )
      .returning();
    if (!updated) return null;
    if (proposal && proposal.status === "PROPOSED") {
      const status =
        proposal.proposedCriticality === input.criticality ? "CONFIRMED" : "OVERRIDDEN";
      const [moved] = await ctx.db
        .update(criticalityProposals)
        .set({ status })
        .where(
          and(
            eq(criticalityProposals.businessId, ctx.businessId),
            eq(criticalityProposals.id, proposal.id),
          ),
        )
        .returning();
      if (moved) proposal = toProposal(moved);
    }
    return { obligation: toObligation(updated), proposal };
  } catch (error) {
    throw translateDbError(error);
  }
}
