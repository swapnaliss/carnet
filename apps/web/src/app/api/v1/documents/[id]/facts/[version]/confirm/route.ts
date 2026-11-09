// POST /api/v1/documents/{id}/facts/{version}/confirm (M2-02): an owner confirms the latest version of
// a document's facts, optionally correcting values; the result is version n+1.
import { defineRoute } from "../../../../../../../../lib/define-route";
import { factsRouteSpecs } from "../../../../../../../../server/documents/facts-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = defineRoute(factsRouteSpecs().confirm);
