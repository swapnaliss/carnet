// GET /api/v1/payments/{id}/evidence-check (M2-03): any signed-in role. The strength flag, the ordered
// reasons, each rule's result and the linked documents with their facts, quotes and pages. Computed by
// code from verified or owner-confirmed facts; another business's payment is 404.
import { defineRoute } from "../../../../../../lib/define-route";
import { evidenceSpecs } from "../../../../../../server/evidence-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = defineRoute(evidenceSpecs.check);
