// GET /api/v1/rfis (spec in src/server/rfi-routes.ts).
import { defineRoute } from "../../../../lib/define-route";
import { rfiListSpec } from "../../../../server/rfi-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = defineRoute(rfiListSpec);
