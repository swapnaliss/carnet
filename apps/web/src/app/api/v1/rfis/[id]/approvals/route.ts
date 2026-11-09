// POST /api/v1/rfis/{id}/approvals (bind and approve a draft), GET (the RFI's approvals).
// Specs and contract: src/server/approvals.ts.
import { defineRoute } from "../../../../../../lib/define-route";
import { approvalSpecs } from "../../../../../../server/approval-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = defineRoute(approvalSpecs.list);
export const POST = defineRoute(approvalSpecs.create);
