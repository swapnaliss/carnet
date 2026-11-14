// GET /api/v1/plans/{revision}: one stored plan revision.
import { defineRoute } from "../../../../../lib/define-route";
import { planSpecs } from "../../../../../server/plan-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = defineRoute(planSpecs.byRevision);
