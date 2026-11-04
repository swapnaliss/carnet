// Token cache (single flight, 25-minute refresh, one re-login on 401) and secret hygiene.
import { inspect } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { AirwallexApiError, configFromEnv, LOGIN_PATH, type Logger } from "../src/index";
import {
  blockedCalls,
  FetchStub,
  loadFixture,
  makeClient,
  TEST_API_KEY,
  TEST_CLIENT_ID,
  toResponse,
} from "./fixture-loader";

const BALANCES = "/api/v1/balances/current";
const MIN = 60_000;

function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const rec = (level: string) => (obj: Record<string, unknown>, msg?: string) =>
    void lines.push(`${level} ${msg ?? ""} ${JSON.stringify(obj)}`);
  return {
    lines,
    logger: { debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error") },
  };
}

afterAll(() => {
  expect(blockedCalls).toEqual([]);
});

describe("token cache", () => {
  it("two concurrent calls trigger one login", async () => {
    const stub = new FetchStub()
      .fixture("balances-after-transfer-create")
      .fixture("transfer-fetch-local");
    const client = makeClient(stub);
    await Promise.all([
      client.getBalances(),
      client.getTransfer("420468b9-15f0-4e07-a015-155c99b92444"),
      client.getBalances(),
    ]);
    expect(stub.count("POST", LOGIN_PATH)).toBe(1);
    expect(
      stub.calls.filter((c) => c.path !== LOGIN_PATH).every((c) => c.headers.authorization),
    ).toBe(true);
  });

  it("refreshes after 25 minutes (fake clock) and not before", async () => {
    let now = 1_793_000_000_000;
    const stub = new FetchStub().fixture("balances-after-transfer-create");
    const client = makeClient(stub, { now: () => now });
    await client.getBalances();
    now += 25 * MIN - 1;
    await client.getBalances();
    expect(stub.count("POST", LOGIN_PATH)).toBe(1);
    now += 1;
    await client.getBalances();
    expect(stub.count("POST", LOGIN_PATH)).toBe(2);
  });

  it("a 401 (fixture auth-invalid-token) triggers exactly one re-login and a repeat", async () => {
    const stub = new FetchStub()
      .fixture("balances-after-transfer-create")
      .on("GET", BALANCES, loadFixture("auth-invalid-token").response, 1);
    const balances = await makeClient(stub).getBalances();
    expect(balances.length).toBeGreaterThan(0);
    expect(stub.count("POST", LOGIN_PATH)).toBe(2);
    expect(stub.count("GET", BALANCES)).toBe(2);
  });

  it("a persistent 401 re-logs in once, then surfaces the 401", async () => {
    const stub = new FetchStub().fixture("auth-invalid-token");
    const err = await makeClient(stub)
      .getBalances()
      .catch((e: unknown) => e);
    expect((err as AirwallexApiError).status).toBe(401);
    expect(stub.count("POST", LOGIN_PATH)).toBe(2);
    expect(stub.count("GET", BALANCES)).toBe(2);
  });

  it("sends the credentials only as login headers", async () => {
    const stub = new FetchStub().fixture("balances-after-transfer-create");
    await makeClient(stub).getBalances();
    const login = stub.calls.find((c) => c.path === LOGIN_PATH);
    expect(login?.headers["x-client-id"]).toBe(TEST_CLIENT_ID);
    expect(login?.headers["x-api-key"]).toBe(TEST_API_KEY);
    const other = stub.calls.find((c) => c.path === BALANCES);
    expect(JSON.stringify(other?.headers)).not.toContain(TEST_API_KEY);
  });
});

describe("no secret in logs or errors", () => {
  it("a failed login (fixture auth-login-bad-key): error and logs contain neither key nor client id", async () => {
    const { logger, lines } = captureLogger();
    const stub = new FetchStub().fixture("auth-login-bad-key");
    const client = makeClient(stub, { logger });
    const err = await client.getBalances().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AirwallexApiError);
    expect((err as AirwallexApiError).code).toBe("credentials_invalid");
    const surfaces = [
      String(err),
      (err as Error).toString(),
      (err as Error).stack ?? "",
      JSON.stringify(err),
      inspect(err, { depth: 5 }),
      inspect(client, { depth: 5 }),
      JSON.stringify(client.tokens),
      ...lines,
    ].join("\n");
    expect(lines.some((l) => l.includes("airwallex login failed"))).toBe(true);
    expect(surfaces).not.toContain(TEST_API_KEY);
    expect(surfaces).not.toContain(TEST_CLIENT_ID);
  });

  it("a call failing after login: neither the key nor the token appears", async () => {
    const TOKEN = "tok-very-secret-bearer-0001";
    const { logger, lines } = captureLogger();
    const stub = new FetchStub()
      .on("POST", LOGIN_PATH, () =>
        toResponse({ status: 201, body: { token: TOKEN, expires_at: "2026-11-04T10:00:00+0000" } }),
      )
      .fixture("error-transfer-not-found");
    const client = makeClient(stub, { logger });
    const err = await client
      .getTransfer("00000000-0000-0000-0000-000000000000")
      .catch((e: unknown) => e);
    expect((err as AirwallexApiError).code).toBe("not_found");
    const surfaces = [
      String(err),
      (err as Error).stack ?? "",
      inspect(err),
      inspect(client),
      ...lines,
    ].join("\n");
    expect(surfaces).not.toContain(TOKEN);
    expect(surfaces).not.toContain(TEST_API_KEY);
    // the token was really used on the wire
    expect(
      stub.calls.find((c) => c.path.startsWith("/api/v1/transfers/"))?.headers.authorization,
    ).toBe(`Bearer ${TOKEN}`);
  });

  it("configFromEnv names a missing key without echoing values and refuses non-sandbox hosts", () => {
    expect(() => configFromEnv({ AIRWALLEX_CLIENT_ID: "abc" })).toThrow(
      "missing environment variable AIRWALLEX_API_KEY",
    );
    expect(() =>
      configFromEnv({
        AIRWALLEX_CLIENT_ID: "abc",
        AIRWALLEX_API_KEY: "def",
        AIRWALLEX_BASE_URL: "https://api.airwallex.com",
      }),
    ).toThrow(/sandbox/);
    const cfg = configFromEnv({ AIRWALLEX_CLIENT_ID: "abc", AIRWALLEX_API_KEY: "def" });
    expect(cfg.baseUrl).toBe("https://api.sandbox.airwallex.com");
    expect(cfg.filesUrl).toBe("https://files.sandbox.airwallex.com");
  });
});
