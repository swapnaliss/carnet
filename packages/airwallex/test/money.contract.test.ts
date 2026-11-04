// Wire amounts <-> domain Money without float arithmetic (BL-01 6625668304): inbound numbers keep
// their exact source digits; outbound Money is sent only when the JSON number reproduces it exactly.
import { type Currency, formatMajor, parseMajor } from "@carnet/domain";
import { afterAll, describe, expect, it } from "vitest";
import {
  AirwallexInputError,
  AirwallexInvalidResponse,
  BalancesWire,
  TransferWire,
  WireNumber,
} from "../src/index";
import { parseJsonPreservingNumbers } from "../src/json";
import { toWireAmount } from "../src/wire";
import {
  blockedCalls,
  FetchStub,
  FIXTURE_DIR,
  fixtureNames,
  isRecordedCall,
  loadFixture,
  makeClient,
  readJson,
  toResponse,
} from "./fixture-loader";

afterAll(() => {
  expect(blockedCalls).toEqual([]);
});

describe("inbound: exact source digits", () => {
  it("the client parser keeps each number's source text", () => {
    const v = parseJsonPreservingNumbers('{"a":43.41,"b":0.1,"c":[1e2,10]}') as {
      a: WireNumber;
      b: WireNumber;
      c: WireNumber[];
    };
    expect(v.a).toBeInstanceOf(WireNumber);
    expect(v.a.source).toBe("43.41");
    expect(v.b.source).toBe("0.1");
    expect(v.c.map((n) => n.source)).toEqual(["1e2", "10"]);
  });

  it("every transfer fixture maps to Money in its own currency, equal to the recorded digits", () => {
    let checked = 0;
    for (const name of fixtureNames()) {
      const raw0 = readJson(`${FIXTURE_DIR}${name}.json`);
      if (!isRecordedCall(raw0)) continue;
      const f = raw0;
      const body = f.response.body as Record<string, unknown>;
      if (f.response.status >= 300 || typeof body !== "object" || !("transfer_currency" in body))
        continue;
      const raw = JSON.stringify(body);
      const t = TransferWire.parse(parseJsonPreservingNumbers(raw));
      const src = body.source_amount;
      if (typeof src === "number") {
        expect(t.sourceAmount).toEqual(parseMajor(String(src), body.source_currency as Currency));
      }
      const pays = body.amount_payer_pays;
      if (typeof pays === "number") {
        expect(formatMajor(t.amountPayerPays ?? { minor: -1n, currency: "USD" })).toBe(
          formatMajor(parseMajor(String(pays), body.source_currency as Currency)),
        );
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(30);
  });

  it("all 46 balance currencies in the fixture are in the domain table and parse", () => {
    const rows = BalancesWire.parse(
      parseJsonPreservingNumbers(
        JSON.stringify(loadFixture("balances-after-transfer-create").response.body),
      ),
    );
    expect(rows).toHaveLength(46);
    const usd = rows.find((r) => r.currency === "USD");
    expect(usd?.available.minor).toBeTypeOf("bigint");
  });

  it("a 0-decimal (JPY) and a 3-decimal (BHD) amount map exactly (constructed: no fixture has one)", () => {
    const jpy = `{"id":"t","request_id":"r","status":"PAID","beneficiary_id":"b","transfer_method":"LOCAL","source_currency":"JPY","source_amount":123456789,"transfer_currency":"BHD","transfer_amount":12.345,"created_at":"x","updated_at":"y"}`;
    const t = TransferWire.parse(parseJsonPreservingNumbers(jpy));
    expect(t.sourceAmount).toEqual({ minor: 123456789n, currency: "JPY" });
    expect(t.transferAmount).toEqual({ minor: 12345n, currency: "BHD" });
  });

  it("an amount with more decimals than the currency allows, or in exponent form, fails loudly", async () => {
    const tooMany = `{"id":"t","request_id":"r","status":"PAID","beneficiary_id":"b","transfer_method":"LOCAL","source_currency":"JPY","source_amount":10.5,"transfer_currency":"USD","transfer_amount":1e2,"created_at":"x","updated_at":"y"}`;
    expect(TransferWire.safeParse(parseJsonPreservingNumbers(tooMany)).success).toBe(false);
    const stub = new FetchStub().on("GET", "/api/v1/transfers/t", () =>
      toResponse({ status: 200, body: JSON.parse(tooMany) }),
    );
    await expect(makeClient(stub).getTransfer("t")).rejects.toBeInstanceOf(
      AirwallexInvalidResponse,
    );
  });

  it("a large amount keeps every digit (beyond float precision)", () => {
    const big = `{"id":"t","request_id":"r","status":"PAID","beneficiary_id":"b","transfer_method":"LOCAL","source_currency":"USD","source_amount":12345678901234567.89,"transfer_currency":"USD","created_at":"x","updated_at":"y"}`;
    const t = TransferWire.parse(parseJsonPreservingNumbers(big));
    expect(t.sourceAmount?.minor).toBe(1234567890123456789n);
  });
});

describe("outbound: exact JSON numbers only", () => {
  it.each([
    ["25", "USD", 25],
    ["13.41", "EUR", 13.41],
    ["0.01", "USD", 0.01],
    ["1000", "JPY", 1000],
    ["12.345", "BHD", 12.345],
  ] as const)("%s %s is sent as %d", (s, c, n) => {
    expect(toWireAmount(parseMajor(s, c), "amount")).toBe(n);
    expect(JSON.stringify(toWireAmount(parseMajor(s, c), "amount"))).toBe(String(n));
  });

  it("refuses an amount a JSON number cannot carry exactly, a zero, and a currency mismatch", () => {
    expect(() => toWireAmount(parseMajor("12345678901234567.89", "USD"), "amount")).toThrow(
      AirwallexInputError,
    );
    expect(() => toWireAmount(parseMajor("0", "USD"), "amount")).toThrow(AirwallexInputError);
    expect(() => toWireAmount(parseMajor("5", "EUR"), "amount", "USD")).toThrow(/expected USD/);
  });
});
