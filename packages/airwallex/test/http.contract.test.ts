// HTTP core: timeout, retry with retry-after, 5xx exhaustion, jitter, no retry of a POST without a
// request_id, x-api-version handling. Responses are the recorded fixtures; 429/5xx are constructed
// (the sandbox never returned a 429 in M0-03, docs/evidence/airwallex-money-path.md).
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  AirwallexApiError,
  AirwallexRateLimited,
  AirwallexTimeout,
  backoffDelay,
  createAirwallexClient,
  parseRetryAfter,
} from "../src/index";
import {
  blockedCalls,
  FetchStub,
  hangUntilAborted,
  loadFixture,
  makeClient,
  TEST_API_KEY,
  TEST_CLIENT_ID,
  toResponse,
} from "./fixture-loader";

const BALANCES = "/api/v1/balances/current";
const status =
  (s: number, headers: Record<string, string> = {}) =>
  () =>
    toResponse({ status: s, headers, body: { code: `http_${s}`, message: "constructed" } });

afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  expect(blockedCalls).toEqual([]);
});

describe("timeout", () => {
  it("rejects with AirwallexTimeout at 10 s for an endpoint that never answers", async () => {
    vi.useFakeTimers();
    const stub = new FetchStub().on("GET", "/api/v1/transfers/t-1", (_c, init) =>
      hangUntilAborted(init),
    );
    const client = makeClient(stub);
    let settled = false;
    const p = client.getTransfer("t-1").then(
      () => "resolved",
      (e: unknown) => e,
    );
    void p.finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await p;
    expect(err).toBeInstanceOf(AirwallexTimeout);
    expect((err as AirwallexTimeout).timeoutMs).toBe(10_000);
    // a timeout is not retried (the outcome may be unknown)
    expect(stub.count("GET", "/api/v1/transfers/t-1")).toBe(1);
  });
});

describe("retry", () => {
  it("429 with retry-after then 200 succeeds after waiting at least the header value", async () => {
    vi.useFakeTimers();
    const stub = new FetchStub()
      .fallbackFixture("auth-login")
      .fixture("balances-after-transfer-create")
      .on("GET", BALANCES, status(429, { "retry-after": "2" }), 1);
    // default sleep (real setTimeout under fake timers), jitter forced to its maximum below 2 s
    const client = createAirwallexClient({
      clientId: TEST_CLIENT_ID,
      apiKey: TEST_API_KEY,
      baseUrl: "https://api.sandbox.airwallex.com",
      filesUrl: "https://files.sandbox.airwallex.com",
      fetch: stub.fetch,
      random: () => 0.999,
    });
    let done = false;
    const p = client.getBalances().then((v) => {
      done = true;
      return v;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(done).toBe(false);
    expect(stub.count("GET", BALANCES)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const balances = await p;
    expect(done).toBe(true);
    expect(stub.count("GET", BALANCES)).toBe(2);
    expect(balances.find((b) => b.currency === "USD")?.availableAmount).toBeDefined();
  });

  it("records the waited delay >= retry-after (seconds and HTTP-date forms)", async () => {
    const delays: number[] = [];
    const stub = new FetchStub()
      .fixture("balances-after-transfer-create")
      .on("GET", BALANCES, status(429, { "retry-after": "3" }), 1);
    await makeClient(stub, { sleep: async (ms) => void delays.push(ms) }).getBalances();
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(3_000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter("garbage", 0)).toBeUndefined();
  });

  it("429 beyond the attempts raises AirwallexRateLimited", async () => {
    const stub = new FetchStub().on("GET", BALANCES, status(429, { "retry-after": "1" }));
    const err = await makeClient(stub)
      .getBalances()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AirwallexRateLimited);
    expect((err as AirwallexRateLimited).retryAfterMs).toBe(1_000);
    expect(stub.count("GET", BALANCES)).toBe(3);
  });

  it.each([502, 503, 504])(
    "%i exhaustion raises the typed error after the configured attempts",
    async (s) => {
      const stub = new FetchStub().on("GET", BALANCES, status(s));
      const err = await makeClient(stub, { maxAttempts: 4 })
        .getBalances()
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AirwallexApiError);
      expect((err as AirwallexApiError).status).toBe(s);
      expect(stub.count("GET", BALANCES)).toBe(4);
    },
  );

  it("500 is not retried (only 429/502/503/504 and network errors are)", async () => {
    const stub = new FetchStub().on("GET", BALANCES, status(500));
    await expect(makeClient(stub).getBalances()).rejects.toBeInstanceOf(AirwallexApiError);
    expect(stub.count("GET", BALANCES)).toBe(1);
  });

  it("a network error on a GET is retried", async () => {
    let first = true;
    const stub = new FetchStub().on("GET", BALANCES, () => {
      if (first) {
        first = false;
        throw new TypeError("fetch failed");
      }
      return toResponse(loadFixture("balances-after-transfer-create").response);
    });
    await expect(makeClient(stub).getBalances()).resolves.toBeInstanceOf(Array);
    expect(stub.count("GET", BALANCES)).toBe(2);
  });

  it("a POST without a request_id (RFI respond) is never retried", async () => {
    const path = "/api/v1/rfis/r-1/respond";
    const stub = new FetchStub().on("POST", path, status(503));
    const err = await makeClient(stub)
      .respondRfi({
        rfiId: "r-1",
        answers: [{ questionId: "q", answer: { type: "TEXT", text: "x" } }],
      })
      .catch((e: unknown) => e);
    expect((err as AirwallexApiError).status).toBe(503);
    expect(stub.count("POST", path)).toBe(1);
  });

  it("backoff delays use full jitter: within [0, cap] and different across runs", async () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const cap = Math.min(4_000, 250 * 2 ** (attempt - 1));
      for (let i = 0; i < 200; i++) {
        const d = backoffDelay(attempt, 250, 4_000, Math.random);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(cap);
      }
    }
    // through the client: two runs of the same 503 sequence wait different amounts
    const run = async () => {
      const delays: number[] = [];
      const stub = new FetchStub().on("GET", BALANCES, status(503));
      await makeClient(stub, { sleep: async (ms) => void delays.push(ms), random: Math.random })
        .getBalances()
        .catch(() => undefined);
      return delays;
    };
    const runs = await Promise.all(Array.from({ length: 10 }, run));
    for (const r of runs) {
      expect(r).toHaveLength(2);
      expect(r[0]).toBeLessThanOrEqual(250);
      expect(r[1]).toBeLessThanOrEqual(500);
    }
    expect(new Set(runs.map((r) => r.join(","))).size).toBeGreaterThan(1);
  });
});

describe("x-api-version", () => {
  it("is off by default (the fixtures were recorded without it)", async () => {
    const stub = new FetchStub().fixture("balances-after-transfer-create");
    await makeClient(stub).getBalances();
    expect(stub.calls.every((c) => c.headers["x-api-version"] === undefined)).toBe(true);
  });

  it("when configured, is sent on non-FX calls and never on FX calls", async () => {
    const stub = new FetchStub()
      .fixture("balances-after-transfer-create")
      .fixture("fx-quote-create")
      .fixture("fx-conversion-fetch");
    const client = makeClient(stub, { apiVersion: "2025-06-30" });
    await client.getBalances();
    await client.createQuote({
      buyCurrency: "EUR",
      sellCurrency: "USD",
      sellAmount: "100",
      validity: "MIN_15",
    });
    await client.getConversion("fa8ba678-99cb-4d69-9435-5d1b6428e5f0");
    const byPath = (p: string) => stub.calls.find((c) => c.path.startsWith(p));
    expect(byPath(BALANCES)?.headers["x-api-version"]).toBe("2025-06-30");
    expect(byPath("/api/v1/fx/quotes")?.headers["x-api-version"]).toBeUndefined();
    expect(byPath("/api/v1/fx/conversions")?.headers["x-api-version"]).toBeUndefined();
  });
});
