// DELETE revokes a payee status link (M3-06). Contract: server/payee-links-routes.ts.
import { defineRoute } from "../../../../../../../lib/define-route";
import { payeeLinkSpecs } from "../../../../../../../server/payee-links-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = defineRoute(payeeLinkSpecs.revoke);
