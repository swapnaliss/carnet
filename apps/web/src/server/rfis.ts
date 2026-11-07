// Wire shapes for the RFI read routes (M2-04). snake_case JSON; times are ISO strings.
import type { Rfi, RfiQuestionRow } from "@carnet/db";

export function rfiJson(r: Rfi) {
  return {
    id: r.id,
    airwallex_rfi_id: r.airwallexRfiId,
    type: r.type,
    state: r.state,
    round: r.round,
    airwallex_status: r.airwallexStatus,
    airwallex_updated_at: r.airwallexUpdatedAt.toISOString(),
    expires_at: r.expiresAt?.toISOString() ?? null,
    expiring_soon: r.expiringSoon,
    // CLOSED while Carnet had not answered: the owner is told to ask Airwallex.
    expired: r.state === "EXPIRED",
    payment_id: r.paymentId,
    orphan_reason: r.orphanReason,
    linked_by: r.linkedBy,
    conflict: r.conflict,
    created_at: r.createdAt.toISOString(),
  };
}

export function rfiQuestionJson(q: RfiQuestionRow) {
  return {
    id: q.id,
    airwallex_question_id: q.airwallexQuestionId,
    round: q.round,
    position: q.position,
    title: q.title,
    description: q.description,
    comment: q.comment,
    answer_type: q.answerType,
    sources: q.sources,
    reopened: q.reopened,
    needs_drafting: q.needsDrafting,
  };
}
