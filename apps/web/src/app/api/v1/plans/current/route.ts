// GET /api/v1/plans/current: the newest plan revision with its before/after, actions and states.
import { defineRoute } from "../../../../../lib/define-route";
import { planSpecs } from "../../../../../server/plan-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = defineRoute(planSpecs.current);
