// POST /api/v1/rfis/{id}/approvals/{approvalId}/reject (spec in src/server/approvals.ts).
import { defineRoute } from "../../../../../../../../lib/define-route";
import { approvalSpecs } from "../../../../../../../../server/approval-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = defineRoute(approvalSpecs.reject);
