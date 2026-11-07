// POST /api/v1/rfis/{id}/link (spec in src/server/rfi-routes.ts).
import { defineRoute } from "../../../../../../lib/define-route";
import { rfiLinkSpec } from "../../../../../../server/rfi-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = defineRoute(rfiLinkSpec);
