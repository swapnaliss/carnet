// The payment routes bound to the process kit (session auth, app database, process logger) and the
// web tier's Airwallex balance reader. The route files under app/api/v1/payments re-export these.
import { defineRawRoute, defineRoute } from "../lib/define-route";
import { readBalances } from "./airwallex";
import { createPaymentRoutes } from "./payments";

export const paymentRoutes = createPaymentRoutes(
  { defineRoute, defineRawRoute },
  { balances: readBalances },
);
