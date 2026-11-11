// GET /api/v1/rfis/{id}/hold: the hold screen's read model (spec in src/server/hold.ts).
import { defineRoute } from "../../../../../../lib/define-route";
import { holdViewSpec } from "../../../../../../server/hold";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = defineRoute(holdViewSpec);
