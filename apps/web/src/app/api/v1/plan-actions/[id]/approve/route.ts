// POST /api/v1/plan-actions/{id}/approve: a bound approval of a payout or an out-of-policy conversion.
import { defineRoute } from "../../../../../../lib/define-route";
import { planSpecs } from "../../../../../../server/plan-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = defineRoute(planSpecs.approve);
