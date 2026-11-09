// POST /api/v1/rfis/{id}/reuse (spec in src/server/reuse-routes.ts).
import { defineRoute } from "../../../../../../lib/define-route";
import { rfiReuseSpec } from "../../../../../../server/reuse-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = defineRoute(rfiReuseSpec);
