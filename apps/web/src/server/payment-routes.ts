// The payment route specs bound to the web tier's Airwallex balance reader. The route files under
// app/api/v1/payments pass them to the process `defineRoute`.
import { readBalances } from "./airwallex";
import { paymentRouteSpecs } from "./payments";

export const paymentSpecs = paymentRouteSpecs({ balances: readBalances });
