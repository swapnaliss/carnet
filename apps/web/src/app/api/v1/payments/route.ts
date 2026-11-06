// GET  /api/v1/payments: any signed-in role (the judge viewer included) → { items, server_time }.
// POST /api/v1/payments: owner only; `Idempotency-Key` required. Body
// `{ amount: { amount: "25.00", currency: "USD" }, reference, counterparty_id? }`. Checks the sandbox
// balance, then writes the payment, its INTENT ExecutionAttempt and the `transfer.create` job in one
// transaction → 201 { payment }. Contract and errors: src/server/payments.ts.
import { defineRoute } from "../../../../lib/define-route";
import { paymentSpecs } from "../../../../server/payment-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = defineRoute(paymentSpecs.list);
export const POST = defineRoute(paymentSpecs.create);
