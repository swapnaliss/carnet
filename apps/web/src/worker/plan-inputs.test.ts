// The indicative-rate arithmetic of the production plan-inputs loader (ADR 0021), on the recorded
// `fx-current-rate` answer (M0-03: CLIENT level, 100 USD buys 88.47 EUR).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CurrentRate } from "@carnet/airwallex";
import { describe, expect, it } from "vitest";
import { clientRateOf, ratioDecimal } from "./plan-inputs";

const recorded = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../fixtures/airwallex/fx-current-rate.json", import.meta.url)),
    "utf8",
  ),
) as {
  response: {
    body: {
      rate_details: { level: string; rate: number; buy_amount: number; sell_amount: number }[];
    };
  };
};

const asRate = (levels: string[]): CurrentRate => ({
  buyCurrency: "EUR",
  sellCurrency: "USD",
  currencyPair: "EURUSD",
  createdAt: "2026-11-03T09:43:19+0000",
  details: recorded.response.body.rate_details
    .filter((d) => levels.includes(d.level))
    .map((d) => ({
      level: d.level,
      rate: String(d.rate),
      buyAmount: String(d.buy_amount),
      sellAmount: String(d.sell_amount),
    })),
});

describe("ratioDecimal", () => {
  it("divides exactly and rounds down", () => {
    expect(ratioDecimal("88.47", "100", 4)).toBe("0.8847");
    expect(ratioDecimal("1", "3", 4)).toBe("0.3333");
    expect(ratioDecimal("2", "3", 4)).toBe("0.6666"); // down, never up
    expect(ratioDecimal("0.005", "100", 4)).toBe("0.0000");
  });

  it("refuses what is not a plain decimal or divides by zero", () => {
    expect(ratioDecimal("1e3", "100", 4)).toBeNull();
    expect(ratioDecimal("-1", "100", 4)).toBeNull();
    expect(ratioDecimal("1", "0", 4)).toBeNull();
  });
});

describe("clientRateOf", () => {
  it("reads the CLIENT level of the recorded answer as buy per sell", () => {
    expect(clientRateOf(asRate(["AWX", "CLIENT"]))).toBe("0.8847");
  });

  it("is null without a CLIENT level or with a zero rate", () => {
    expect(clientRateOf(asRate(["AWX"]))).toBeNull();
    const zero = asRate(["CLIENT"]);
    zero.details = zero.details.map((d) => ({ ...d, buyAmount: "0.00" }));
    expect(clientRateOf(zero)).toBeNull();
  });
});
