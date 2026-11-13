// POST /api/v1/obligations/{id}/criticality/confirm: the only way a criticality is set (M3-01, ADR 0011).
import { defineRoute } from "../../../../../../../lib/define-route";
import { obligationSpecs } from "../../../../../../../server/obligation-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = defineRoute(obligationSpecs.confirm);
