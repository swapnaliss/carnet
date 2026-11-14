// The plan route specs bound to the process defaults (clock, TTL, kill switch, the live Airwallex read
// for payout details). The route files under app/api/v1/plans and plan-actions pass them to the process
// `defineRoute`; tests build the same specs with their own clock and payout reader.
import { planRouteSpecs } from "./plans";

export const planSpecs = planRouteSpecs();
