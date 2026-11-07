// GET /api/v1/documents/{id}/facts (M2-02): every version of the extracted facts and the usable ones.
import { defineRoute } from "../../../../../../lib/define-route";
import { factsRouteSpecs } from "../../../../../../server/documents/facts-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = defineRoute(factsRouteSpecs().list);
