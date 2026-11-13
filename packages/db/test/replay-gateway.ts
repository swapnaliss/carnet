// Test support (M3-03): the REAL Airwallex client (packages/airwallex) wired to a local fetch that replays
// the recorded sandbox responses under fixtures/airwallex/ (M0-03). Bodies are the recorded ones with the
// fields a scenario varies (amounts, ids, the request's own request_id) replaced; the shapes, status codes
// and header handling are the adapter's own. No network: importing the loader blocks it.
import { readFileSync } from "node:fs";
import type { createAirwallexClient } from "../../airwallex/src/index";
import {
  FetchStub,
  FIXTURE_DIR,
  makeClient,
  type StubCall,
  toResponse,
} from "../../airwallex/test/fixture-loader";

type Json = Record<string, unknown>;
const fixtureBody = (name: string): unknown =>
  (
    JSON.parse(readFileSync(`${FIXTURE_DIR}${name}.json`, "utf8")) as {
      response: { body: unknown };
    }
  ).response.body;

const awxTime = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "+0000");

export interface ReplayServer {
  /** Major-unit available balances by currency (every other currency is 0). */
  balances: Record<string, number>;
  /** Buy per sell, major units. */
  quoteRate: number;
  /** Quote ids to hand out in order; when empty a fresh `quote-<n>` is minted. */
  quoteIds: string[];
  /**
   * `ok`; `lost`: Airwallex creates it but the answer never arrives (every call answers 503);
   * `dropped`: the request never reached Airwallex (503, nothing created); `reject`: a 4xx.
   */
  conversionMode: "ok" | "lost" | "dropped" | "reject";
  transferMode: "ok" | "lost" | "dropped" | "reject";
  /** The beneficiary's account number as Airwallex returns it. */
  beneficiaryAccount: string;
  clock: () => Date;
  /** What the sandbox holds, by request_id. */
  conversions: Map<string, Json>;
  transfers: Map<string, Json>;
  quoteRequests: StubCall[];
  conversionRequests: StubCall[];
  transferRequests: StubCall[];
}

export type ReplayClient = ReturnType<typeof createAirwallexClient>;

export function replayGateway(
  overrides: Partial<ReplayServer> = {},
  clientConfig: Parameters<typeof makeClient>[1] = {},
): {
  client: ReplayClient;
  server: ReplayServer;
  stub: FetchStub;
} {
  const server: ReplayServer = {
    balances: { USD: 100_000, EUR: 500 },
    quoteRate: 0.884,
    quoteIds: [],
    conversionMode: "ok",
    transferMode: "ok",
    beneficiaryAccount: "1234567890",
    clock: () => new Date(),
    conversions: new Map(),
    transfers: new Map(),
    quoteRequests: [],
    conversionRequests: [],
    transferRequests: [],
    ...overrides,
  };
  const stub = new FetchStub();

  stub.on("GET", "/api/v1/balances/current", () => {
    const rows = fixtureBody("balances-after-transfer-create") as Json[];
    const body = rows.map((r) => {
      const c = String(r.currency);
      const v = server.balances[c] ?? 0;
      return { ...r, available_amount: v, total_amount: v };
    });
    return toResponse({ status: 200, body });
  });

  stub.on("POST", "/api/v1/fx/quotes/create", (call) => {
    server.quoteRequests.push(call);
    const req = call.json as Json;
    const sell = Number(req.sell_amount);
    const buy = Math.round(sell * server.quoteRate * 100) / 100;
    const base = fixtureBody("fx-quote-create") as Json;
    const now = server.clock();
    return toResponse({
      status: 200,
      body: {
        ...base,
        quote_id: server.quoteIds.shift() ?? `quote-${crypto.randomUUID()}`,
        buy_currency: req.buy_currency,
        sell_currency: req.sell_currency,
        sell_amount: sell,
        buy_amount: buy,
        valid_from_at: awxTime(now),
        valid_to_at: awxTime(new Date(now.getTime() + 15 * 60_000)),
      },
    });
  });

  const conversionBody = (req: Json): Json => {
    const base = fixtureBody("fx-conversion-create") as Json;
    const sell = Number(req.sell_amount);
    return {
      ...base,
      conversion_id: `conversion-${crypto.randomUUID()}`,
      request_id: req.request_id,
      quote_id: req.quote_id ?? null,
      buy_currency: req.buy_currency,
      sell_currency: req.sell_currency,
      sell_amount: sell,
      buy_amount: Math.round(sell * server.quoteRate * 100) / 100,
      created_at: awxTime(server.clock()),
    };
  };

  stub.on("POST", "/api/v1/fx/conversions/create", (call) => {
    server.conversionRequests.push(call);
    const req = call.json as Json;
    if (server.conversionMode === "reject") {
      return toResponse({
        status: 400,
        body: {
          code: "validation_error",
          message: "rejected by the sandbox",
          source: "sell_amount",
        },
      });
    }
    const id = String(req.request_id);
    if (server.conversionMode === "dropped") {
      return toResponse({
        status: 503,
        body: { code: "service_unavailable", message: "try later" },
      });
    }
    if (!server.conversions.has(id)) server.conversions.set(id, conversionBody(req));
    if (server.conversionMode === "lost") {
      return toResponse({
        status: 503,
        body: { code: "service_unavailable", message: "try later" },
      });
    }
    return toResponse({ status: 201, body: server.conversions.get(id) });
  });

  stub.on("GET", "/api/v1/fx/conversions", (call) => {
    const wanted = call.url.searchParams.get("request_id");
    const items = [...server.conversions.values()].filter(
      (c) => wanted === null || c.request_id === wanted,
    );
    return toResponse({ status: 200, body: { has_more: false, items } });
  });

  stub.on("GET", /^\/api\/v1\/beneficiaries\/[^/]+$/, (call) => {
    const base = fixtureBody("beneficiary-fetch-us") as Json;
    const beneficiary = base.beneficiary as Json;
    const bank = beneficiary.bank_details as Json;
    return toResponse({
      status: 200,
      body: {
        ...base,
        id: call.path.split("/").pop(),
        beneficiary: {
          ...beneficiary,
          bank_details: { ...bank, account_number: server.beneficiaryAccount },
        },
      },
    });
  });

  stub.on("POST", "/api/v1/transfers/create", (call) => {
    server.transferRequests.push(call);
    const req = call.json as Json;
    if (server.transferMode === "reject") {
      return toResponse({
        status: 400,
        body: { code: "validation_error", message: "rejected by the sandbox" },
      });
    }
    const id = String(req.request_id);
    if (server.transferMode === "dropped") {
      return toResponse({
        status: 503,
        body: { code: "service_unavailable", message: "try later" },
      });
    }
    if (!server.transfers.has(id)) {
      const base = fixtureBody("transfer-create-local-usd") as Json;
      server.transfers.set(id, {
        ...base,
        id: `transfer-${crypto.randomUUID()}`,
        request_id: id,
        beneficiary_id: req.beneficiary_id,
        source_currency: req.source_currency,
        transfer_currency: req.transfer_currency,
        source_amount: req.source_amount,
        transfer_amount: req.source_amount,
        transfer_method: req.transfer_method,
        reference: req.reference,
        status: "PROCESSING",
      });
    }
    if (server.transferMode === "lost") {
      return toResponse({
        status: 503,
        body: { code: "service_unavailable", message: "try later" },
      });
    }
    return toResponse({ status: 201, body: server.transfers.get(id) });
  });

  return { client: makeClient(stub, clientConfig), server, stub };
}
