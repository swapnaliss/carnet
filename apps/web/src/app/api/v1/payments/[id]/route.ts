// GET /api/v1/payments/{id}: any signed-in role → { payment, webhooks, server_time }. Another
// business's id is 404 (never 403, never data). `webhooks[].raw_body` is included for the owner only.
import { paymentRoutes } from "../../../../../server/payment-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = paymentRoutes.detail;
