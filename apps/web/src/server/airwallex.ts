// The web process's Airwallex client (M1-08), created on first use from the environment (sandbox
// only; `configFromEnv` refuses any other host). The web tier makes one read in a request, the
// balance check before a payment is created, with a short timeout and no retry; every mutating call
// runs in the worker.
import { type Balance, configFromEnv, createAirwallexClient } from "@carnet/airwallex";
import { logger } from "../lib/logger";

/** A balance read in a request: one attempt, 5 s at most. */
export const WEB_AIRWALLEX_TIMEOUT_MS = 5_000;

export type BalanceReader = () => Promise<Balance[]>;

let client: ReturnType<typeof createAirwallexClient> | null = null;

export function webAirwallex(): ReturnType<typeof createAirwallexClient> {
  client ??= createAirwallexClient({
    ...configFromEnv(process.env),
    timeoutMs: WEB_AIRWALLEX_TIMEOUT_MS,
    maxAttempts: 1,
    logger: logger().child({ component: "airwallex" }),
  });
  return client;
}

export const readBalances: BalanceReader = () => webAirwallex().getBalances();
