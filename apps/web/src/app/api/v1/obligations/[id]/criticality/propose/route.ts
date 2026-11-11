// POST /api/v1/obligations/{id}/criticality/propose: queues the model's reading of a contract (M3-01).
import { defineRoute } from "../../../../../../../lib/define-route";
import { obligationSpecs } from "../../../../../../../server/obligation-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = defineRoute(obligationSpecs.propose);
