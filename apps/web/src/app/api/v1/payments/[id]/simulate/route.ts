// POST /api/v1/payments/{id}/simulate: owner only, sandbox only. Body `{ next_status: "SENT" | "PAID" }`.
// Enqueues a `transfer.simulate` job that calls the real Airwallex `/simulation/*` transition endpoint
// (ADR 0018) → 202 { queued, next_status, job_id }. 409 while the payment has no transfer yet.
import { defineRoute } from "../../../../../../lib/define-route";
import { paymentSpecs } from "../../../../../../server/payment-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = defineRoute(paymentSpecs.simulate);
