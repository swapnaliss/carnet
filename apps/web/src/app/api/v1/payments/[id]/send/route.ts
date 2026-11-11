// POST /api/v1/payments/{id}/send (M2-03): owner only. Sends a saved payment behind the evidence guard.
// Body `{ evidence_ack?: { acknowledged: true, check_hash? } }`. A Weak or Missing payment is refused
// with 412 and the check unless acknowledged; an acknowledged send writes an `evidence_override` audit
// entry holding the reasons shown. 200 { payment, already_sent, evidence }. Contract: src/server/evidence.ts.
import { defineRoute } from "../../../../../../lib/define-route";
import { paymentSpecs } from "../../../../../../server/payment-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = defineRoute(paymentSpecs.send);
