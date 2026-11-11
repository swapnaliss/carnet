// The approval route specs bound to the process defaults (clock, TTL from APPROVAL_TTL_MINUTES, the
// kill switch from system_flags, and the real draft lookup from M2-05). The route files under
// app/api/v1/rfis/[id]/approvals pass them to the process `defineRoute`; tests build the same specs
// with their own clock and draft lookup.
import { getDraft, getLatestDraft } from "@carnet/db";
import { approvalRouteSpecs } from "./approvals";

export const approvalSpecs = approvalRouteSpecs({
  // An approval binds the latest draft of the RFI's current round: a newer draft (an owner edit, a
  // re-draft) is a 409 for the older one.
  isLatestDraft: async (rc, rfi, draftId) =>
    (await getLatestDraft(rc, rfi.id, rfi.round))?.id === draftId,
  // An owner who completed every answer after NEEDS_OWNER (M2-08) approves the new, DRAFT_READY draft.
  draftIsReady: async (rc, _rfi, draftId) => (await getDraft(rc, draftId))?.state === "DRAFT_READY",
});
