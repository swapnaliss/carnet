// The approval route specs bound to the process defaults (clock, TTL from APPROVAL_TTL_MINUTES, the
// kill switch from system_flags). The route files under app/api/v1/rfis/[id]/approvals pass them to
// the process `defineRoute`; tests build the same specs with their own clock and draft lookup.
import { approvalRouteSpecs } from "./approvals";

export const approvalSpecs = approvalRouteSpecs();
