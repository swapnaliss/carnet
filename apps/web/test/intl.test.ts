import { describe, expect, it } from "vitest";
import {
  currencyExponent,
  formatDate,
  formatMoney,
  formatRelative,
  minorToDecimalString,
} from "../src/lib/intl";

// ICU separates a currency code from the number with a no-break space (U+00A0).
const nbsp = " ";

describe("currencyExponent", () => {
  it("reads ISO 4217 exponents: USD 2, EUR 2, JPY 0, BHD 3", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("EUR")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("BHD")).toBe(3);
  });

  it("rejects a string that is not a currency code", () => {
    expect(() => currencyExponent("usd")).toThrow(RangeError);
    expect(() => currencyExponent("US")).toThrow(RangeError);
  });
});

describe("minorToDecimalString", () => {
  it("places the decimal point by exponent without floating point", () => {
    expect(minorToDecimalString(12345n, 2)).toBe("123.45");
    expect(minorToDecimalString(5n, 2)).toBe("0.05");
    expect(minorToDecimalString(-5n, 2)).toBe("-0.05");
    expect(minorToDecimalString(0n, 2)).toBe("0.00");
    expect(minorToDecimalString(1000n, 0)).toBe("1000");
    expect(minorToDecimalString(1n, 3)).toBe("0.001");
  });
});

describe("formatMoney", () => {
  const cases = [
    // [minor, currency, locale, expected]
    [123456n, "USD", "en-US", `USD${nbsp}1,234.56`],
    [123456n, "USD", "en-GB", `USD${nbsp}1,234.56`],
    [1235n, "JPY", "en-US", `JPY${nbsp}1,235`],
    [1235n, "JPY", "en-GB", `JPY${nbsp}1,235`],
    [123456n, "EUR", "en-US", `EUR${nbsp}1,234.56`],
    [123456n, "EUR", "en-GB", `EUR${nbsp}1,234.56`],
  ] as const;

  for (const [minor, currency, locale, expected] of cases) {
    it(`formats ${minor} minor ${currency} in ${locale} as ${expected}`, () => {
      expect(formatMoney({ minor, currency }, locale)).toBe(expected);
    });
  }

  it("shows symbols that differ by locale when asked (USD, JPY, EUR in en-US and en-GB)", () => {
    expect(
      formatMoney({ minor: 123456n, currency: "USD" }, "en-US", { currencyDisplay: "symbol" }),
    ).toBe("$1,234.56");
    expect(
      formatMoney({ minor: 123456n, currency: "USD" }, "en-GB", { currencyDisplay: "symbol" }),
    ).toBe("US$1,234.56");
    expect(
      formatMoney({ minor: 1235n, currency: "JPY" }, "en-US", { currencyDisplay: "symbol" }),
    ).toBe("¥1,235");
    expect(
      formatMoney({ minor: 1235n, currency: "JPY" }, "en-GB", { currencyDisplay: "symbol" }),
    ).toBe("JP¥1,235");
    expect(
      formatMoney({ minor: 123456n, currency: "EUR" }, "en-US", { currencyDisplay: "symbol" }),
    ).toBe("€1,234.56");
    expect(
      formatMoney({ minor: 123456n, currency: "EUR" }, "en-GB", { currencyDisplay: "symbol" }),
    ).toBe("€1,234.56");
  });

  it("JPY (exponent 0) treats minor units as whole yen, never divides by 100", () => {
    expect(
      formatMoney({ minor: 100n, currency: "JPY" }, "en-US", { currencyDisplay: "symbol" }),
    ).toBe("¥100");
  });

  it("keeps every digit above 2^53 minor units (no floating point)", () => {
    // 2^53 + 1 = 9007199254740993 is not representable as a double.
    expect(
      formatMoney({ minor: 9007199254740993n, currency: "USD" }, "en-US", {
        currencyDisplay: "symbol",
      }),
    ).toBe("$90,071,992,547,409.93");
  });

  it("formats negatives and zero, and an explicit sign on request", () => {
    expect(
      formatMoney({ minor: -2500n, currency: "EUR" }, "en-GB", { currencyDisplay: "symbol" }),
    ).toBe("-€25.00");
    expect(
      formatMoney({ minor: 0n, currency: "USD" }, "en-US", { currencyDisplay: "symbol" }),
    ).toBe("$0.00");
    expect(
      formatMoney({ minor: 2500n, currency: "USD" }, "en-US", {
        currencyDisplay: "symbol",
        signDisplay: "always",
      }),
    ).toBe("+$25.00");
  });
});

describe("formatDate", () => {
  const instant = "2026-11-06T17:30:00Z";

  it("formats a date in UTC by default, per locale", () => {
    expect(formatDate(instant, "en-US")).toBe("Nov 6, 2026");
    expect(formatDate(instant, "en-GB")).toBe("6 Nov 2026");
  });

  it("accepts a time style and a time zone", () => {
    expect(
      formatDate(new Date(instant), "en-GB", { timeStyle: "short", timeZone: "Asia/Kolkata" }),
    ).toBe("6 Nov 2026, 23:00");
  });

  it("rejects an invalid date", () => {
    expect(() => formatDate("not a date", "en-US")).toThrow(RangeError);
  });
});

describe("formatRelative", () => {
  const now = "2026-11-04T12:00:00Z";

  it("picks the largest whole unit, past and future", () => {
    expect(formatRelative("2026-11-04T11:57:00Z", now, "en-US")).toBe("3 minutes ago");
    expect(formatRelative("2026-11-06T12:00:00Z", now, "en-US")).toBe("in 2 days");
    expect(formatRelative("2026-11-03T12:00:00Z", now, "en-GB")).toBe("yesterday");
    expect(formatRelative(now, now, "en-US")).toBe("now");
  });

  it("truncates toward zero: 119 seconds ago is 1 minute ago", () => {
    expect(formatRelative("2026-11-04T11:58:01Z", now, "en-US")).toBe("1 minute ago");
  });
});
