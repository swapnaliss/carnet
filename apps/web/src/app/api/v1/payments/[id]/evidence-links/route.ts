// POST /api/v1/payments/{id}/evidence-links (M2-03): owner only. Body `{ document_id }`. Attaches a
// document to the payment as evidence, stores a check snapshot and returns the new check (201; 200 when
// it was already attached). A payment or document of another business is 404.
import { defineRoute } from "../../../../../../lib/define-route";
import { evidenceSpecs } from "../../../../../../server/evidence-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = defineRoute(evidenceSpecs.attach);
