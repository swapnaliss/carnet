// Outbox job for the criticality proposal (M3-01, ADR 0005): queued by `POST /obligations/{id}/criticality/propose`
// in the same transaction as its audit entry; the worker runs the model call. Slow work never runs in a request.
import type { Db } from "@carnet/db";
import { schema } from "@carnet/db";

export const OBLIGATION_JOB_KIND = {
  proposeCriticality: "obligation.criticality.propose",
} as const;

/** A database handle or an open transaction. */
type Tx = Pick<Db, "insert">;

export async function enqueueCriticalityProposal(
  tx: Tx,
  input: { businessId: string; obligationId: string; documentId: string; sessionId?: string },
): Promise<void> {
  await tx
    .insert(schema.outboxJobs)
    .values({ kind: OBLIGATION_JOB_KIND.proposeCriticality, payload: input });
}
