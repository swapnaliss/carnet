// Test support: loads the recorded Airwallex responses (fixtures/airwallex/, M0-03/M0-04/M0-05),
// serves them through a local fetch stub, and blocks the real network. Importing this module replaces
// `globalThis.fetch` with a guard that records and throws, so an unstubbed call can never leave the
// machine; tests assert `blockedCalls` stays empty.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AirwallexClientConfig, createAirwallexClient, type FetchLike } from "../src/index";

export const FIXTURE_DIR = fileURLToPath(new URL("../../../fixtures/airwallex/", import.meta.url));
export const WEBHOOK_DIR = fileURLToPath(
  new URL("../../../fixtures/airwallex/webhooks/", import.meta.url),
);

export interface RecordedResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface Fixture {
  method: "GET" | "POST";
  path: string;
  request?: unknown;
  requestHeaders?: Record<string, string>;
  response: RecordedResponse;
}

export interface WebhookFixture {
  received_at: string;
  headers: Record<string, string>;
  body_utf8: string;
}

export const blockedCalls: string[] = [];
const guard = async (input: unknown): Promise<Response> => {
  blockedCalls.push(String(input));
  throw new Error(`network blocked in tests: ${String(input)}`);
};
globalThis.fetch = guard as typeof fetch;

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Names (without `.json`) of every top-level fixture file. */
export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

export function isRecordedCall(v: unknown): v is Fixture {
  return (
    typeof v === "object" &&
    v !== null &&
    "method" in v &&
    "path" in v &&
    "response" in v &&
    typeof (v as Fixture).response?.status === "number"
  );
}

export function loadFixture(name: string): Fixture {
  const v = readJson(`${FIXTURE_DIR}${name}.json`);
  if (!isRecordedCall(v)) throw new Error(`${name} is not a recorded call`);
  return v;
}

export function webhookNames(): string[] {
  return readdirSync(WEBHOOK_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .map((f) => f.slice(0, -5))
    .sort();
}

export function loadWebhook(name: string): WebhookFixture {
  return readJson(`${WEBHOOK_DIR}${name}.json`) as WebhookFixture;
}

export interface StubCall {
  method: string;
  url: URL;
  path: string;
  headers: Record<string, string>;
  json: unknown;
  form: FormData | undefined;
}

type Responder =
  | RecordedResponse
  | ((call: StubCall, init: RequestInit) => Response | Promise<Response>);

interface Route {
  method: string;
  path: string | RegExp;
  respond: Responder;
  times: number;
}

export function toResponse(r: RecordedResponse): Response {
  const body = typeof r.body === "string" ? JSON.stringify(r.body) : JSON.stringify(r.body ?? null);
  return new Response(body, {
    status: r.status,
    headers: { "content-type": "application/json", ...(r.headers ?? {}) },
  });
}

/**
 * A local fetch: routes match on method and pathname (a string matches exactly, a RegExp tests).
 * Later routes are tried first, so a test can override a default. An unmatched call is recorded in
 * `unmatched` and rejected.
 */
export class FetchStub {
  readonly calls: StubCall[] = [];
  readonly unmatched: string[] = [];
  readonly #routes: Route[] = [];

  on(
    method: string,
    path: string | RegExp,
    respond: Responder,
    times = Number.POSITIVE_INFINITY,
  ): this {
    this.#routes.push({ method, path, respond, times });
    return this;
  }

  /** Serves the fixture's recorded response at its recorded method and pathname. */
  fixture(name: string, times?: number): this {
    const f = loadFixture(name);
    return this.on(f.method, new URL(f.path, "https://x").pathname, f.response, times);
  }

  /** Like `fixture`, at the lowest priority (any other matching route wins). */
  fallbackFixture(name: string): this {
    const f = loadFixture(name);
    this.#routes.unshift({
      method: f.method,
      path: new URL(f.path, "https://x").pathname,
      respond: f.response,
      times: Number.POSITIVE_INFINITY,
    });
    return this;
  }

  count(method: string, path: string | RegExp): number {
    return this.calls.filter(
      (c) =>
        c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path)),
    ).length;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const call: StubCall = {
      method: init.method ?? "GET",
      url,
      path: url.pathname,
      headers,
      json: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      form: init.body instanceof FormData ? init.body : undefined,
    };
    this.calls.push(call);
    for (let i = this.#routes.length - 1; i >= 0; i--) {
      const r = this.#routes[i];
      if (!r || r.times <= 0 || r.method !== call.method) continue;
      const hit = typeof r.path === "string" ? r.path === call.path : r.path.test(call.path);
      if (!hit) continue;
      r.times -= 1;
      return typeof r.respond === "function" ? r.respond(call, init) : toResponse(r.respond);
    }
    this.unmatched.push(`${call.method} ${call.path}`);
    throw new Error(`unstubbed call ${call.method} ${call.path}`);
  };
}

/** A fetch that never answers until its signal aborts (for timeout tests). */
export function hangUntilAborted(init: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

export const TEST_CLIENT_ID = "test-client-id-0001";
export const TEST_API_KEY = "test-api-key-secret-0001";

/** A client wired to the stub, with instant sleeps; login answers the recorded `auth-login`. */
export function makeClient(stub: FetchStub, overrides: Partial<AirwallexClientConfig> = {}) {
  stub.fallbackFixture("auth-login");
  return createAirwallexClient({
    clientId: TEST_CLIENT_ID,
    apiKey: TEST_API_KEY,
    baseUrl: "https://api.sandbox.airwallex.com",
    filesUrl: "https://files.sandbox.airwallex.com",
    fetch: stub.fetch,
    sleep: async () => undefined,
    random: () => 0.5,
    ...overrides,
  });
}
