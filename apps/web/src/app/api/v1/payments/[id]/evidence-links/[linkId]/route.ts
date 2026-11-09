// DELETE /api/v1/payments/{id}/evidence-links/{linkId} (M2-03): owner only. Detaches a document, stores
// a check snapshot and returns the new check. Another business's payment or link is 404.
import { defineRoute } from "../../../../../../../lib/define-route";
import { evidenceSpecs } from "../../../../../../../server/evidence-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = defineRoute(evidenceSpecs.detach);
