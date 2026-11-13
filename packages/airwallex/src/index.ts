// @carnet/airwallex: typed raw-REST client for the Airwallex sandbox (no @airwallex/node-sdk).
import { TokenCache } from "./auth";
import { getBalances } from "./balances";
import { createBeneficiary, getBeneficiary } from "./beneficiaries";
import { uploadFile } from "./files";
import {
  createConversion,
  createQuote,
  findConversionByRequestId,
  getConversion,
  listConversions,
} from "./fx";
import { HttpClient, type HttpConfig } from "./http";
import { getRfi, listRfis, respondRfi } from "./rfis";
import { AirwallexSandboxSimulator, type SandboxSimulator } from "./simulator";
import { createTransfer, findTransferByRequestId, getTransfer, listTransfers } from "./transfers";
import type { Ctx } from "./wire";

export * from "./auth";
export * from "./balances";
export * from "./beneficiaries";
export * from "./files";
export * from "./fx";
export * from "./http";
export { WireNumber } from "./json";
export * from "./rfis";
export * from "./simulator";
export * from "./transfers";
export * from "./webhook";
export type { Ctx } from "./wire";

export const packageName = "@carnet/airwallex";

/** Environment keys (values live in `.env` / the platform; never logged). */
export const AIRWALLEX_ENV_KEYS = [
  "AIRWALLEX_CLIENT_ID",
  "AIRWALLEX_API_KEY",
  "AIRWALLEX_BASE_URL",
  "AIRWALLEX_FILES_URL",
  "AIRWALLEX_WEBHOOK_SECRET",
] as const;

export const SANDBOX_BASE_URL = "https://api.sandbox.airwallex.com";
export const SANDBOX_FILES_URL = "https://files.sandbox.airwallex.com";

export interface AirwallexClientConfig extends HttpConfig {
  clientId: string;
  apiKey: string;
  now?: () => number;
}

/** Reads the config from an env map. Throws naming the missing key, never echoing a value. */
export function configFromEnv(
  env: Record<string, string | undefined>,
): Pick<AirwallexClientConfig, "clientId" | "apiKey" | "baseUrl" | "filesUrl"> {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`missing environment variable ${k}`);
    return v;
  };
  const baseUrl = env.AIRWALLEX_BASE_URL || SANDBOX_BASE_URL;
  if (!/sandbox/.test(new URL(baseUrl).hostname)) {
    throw new Error(
      "AIRWALLEX_BASE_URL must point at the sandbox (production keys are never used)",
    );
  }
  return {
    clientId: need("AIRWALLEX_CLIENT_ID"),
    apiKey: need("AIRWALLEX_API_KEY"),
    baseUrl,
    filesUrl: env.AIRWALLEX_FILES_URL || SANDBOX_FILES_URL,
  };
}

export function createAirwallexClient(config: AirwallexClientConfig) {
  const { clientId, apiKey, now, ...httpConfig } = config;
  const http = new HttpClient(httpConfig);
  const tokens = new TokenCache(http, { clientId, apiKey }, now);
  const ctx: Ctx = { http, tokens };
  const simulator: SandboxSimulator = new AirwallexSandboxSimulator(ctx, (id) =>
    getTransfer(ctx, id),
  );
  return {
    tokens,
    simulator,
    createBeneficiary: (input: Parameters<typeof createBeneficiary>[1]) =>
      createBeneficiary(ctx, input),
    getBeneficiary: (id: string) => getBeneficiary(ctx, id),
    createTransfer: (input: Parameters<typeof createTransfer>[1]) => createTransfer(ctx, input),
    getTransfer: (id: string) => getTransfer(ctx, id),
    listTransfers: (input?: Parameters<typeof listTransfers>[1]) => listTransfers(ctx, input),
    findTransferByRequestId: (requestId: string) => findTransferByRequestId(ctx, requestId),
    getBalances: () => getBalances(ctx),
    createQuote: (input: Parameters<typeof createQuote>[1]) => createQuote(ctx, input),
    createConversion: (input: Parameters<typeof createConversion>[1]) =>
      createConversion(ctx, input),
    getConversion: (id: string) => getConversion(ctx, id),
    listConversions: (input?: Parameters<typeof listConversions>[1]) => listConversions(ctx, input),
    findConversionByRequestId: (requestId: string) => findConversionByRequestId(ctx, requestId),
    listRfis: (input?: Parameters<typeof listRfis>[1]) => listRfis(ctx, input),
    getRfi: (id: string) => getRfi(ctx, id),
    respondRfi: (input: Parameters<typeof respondRfi>[1]) => respondRfi(ctx, input),
    uploadFile: (input: Parameters<typeof uploadFile>[1]) => uploadFile(ctx, input),
  };
}

export type AirwallexClient = ReturnType<typeof createAirwallexClient>;
