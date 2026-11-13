// GET /api/v1/obligations: any signed-in user. POST: owner or approver creates an obligation (M3-01).
import { defineRoute } from "../../../../lib/define-route";
import { obligationSpecs } from "../../../../server/obligation-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = defineRoute(obligationSpecs.list);
export const POST = defineRoute(obligationSpecs.create);
