// GET (list) and POST (create) payee status links for a payment (M3-06). Contract and rules:
// server/payee-links-routes.ts.
import { defineRoute } from "../../../../../../lib/define-route";
import { payeeLinkSpecs } from "../../../../../../server/payee-links-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = defineRoute(payeeLinkSpecs.list);
export const POST = defineRoute(payeeLinkSpecs.create);
