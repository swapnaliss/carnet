// One place where an RFI moves along the state machine from Carnet's own code (M2-07: approve, reject,
// the respond executor, the approval sweeps). The caller holds the row lock inside a transaction; this
// validates the edge with `transitionRfi`, writes the state and the `rfi.transition` audit row (the
// same shape M2-04's ingest writes: `{from, to, event, round, source}`). Never touches a payment.
import { appendAudit, enqueuePlanRerun, type RepoCtx, type Rfi, updateRfi } from "@carnet/db";
import { type RfiState, rfiHolds, transitionRfi } from "@carnet/domain";

export type TransitionActor =
  | { actorType: "user"; actorId: string }
  | { actorType: "system"; actorId: "worker" };

/** Moves `rfi` to `to` (throws IllegalRfiTransitionError on an edge the table does not have). */
export async function moveRfi(
  rc: RepoCtx,
  rfi: Rfi,
  to: RfiState,
  actor: TransitionActor,
  source: string,
  extra: Record<string, unknown> = {},
): Promise<Rfi> {
  const rule = transitionRfi(rfi.state, to);
  const updated = await updateRfi(rc, rfi.id, { state: to });
  if (!updated) throw new Error(`rfi ${rfi.id} vanished under lock`);
  await appendAudit(rc, {
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "rfi.transition",
    subject: `rfi:${rfi.id}`,
    data: { from: rule.from, to: rule.to, event: rule.event, round: rfi.round, source, ...extra },
  });
  // A change in whether the RFI holds its payment changes the planner's `held` input (M3-02, ADR 0021).
  if (updated.paymentId !== null && rfiHolds(rule.from) !== rfiHolds(rule.to)) {
    await enqueuePlanRerun(rc.db, {
      businessId: rc.businessId,
      eventId: `rfi:${rfi.id}:${rule.to}`,
      cause: "rfi.holding_changed",
    });
  }
  return updated;
}
