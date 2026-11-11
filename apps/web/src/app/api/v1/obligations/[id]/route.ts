// GET /api/v1/obligations/{id}: any signed-in user; another business's obligation is a 404 (M3-01).
import { defineRoute } from "../../../../../lib/define-route";
import { obligationSpecs } from "../../../../../server/obligation-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = defineRoute(obligationSpecs.get);
