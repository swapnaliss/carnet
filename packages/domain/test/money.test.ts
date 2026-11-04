import { describe, expect, it } from "vitest";
import {
  add,
  allocate,
  CURRENCIES,
  CURRENCY_EXPONENTS,
  type Currency,
  CurrencyMismatchError,
  compare,
  formatMajor,
  MoneyError,
  MoneySchema,
  money,
  negate,
  parseMajor,
  subtract,
  toMoneyWire,
} from "../src/index";
import { prng, RUNS } from "./prng";

describe("currency table", () => {
  it("covers the ticket's required currencies with the right exponents", () => {
    const required = ["USD", "EUR", "GBP", "AUD", "SGD", "HKD", "CNY", "CAD", "NZD"] as const;
    for (const c of required) expect(CURRENCY_EXPONENTS[c]).toBe(2);
    expect(CURRENCY_EXPONENTS.JPY).toBe(0);
  });
});

describe("parseMajor / formatMajor", () => {
  it("parses the documented examples", () => {
    expect(parseMajor("100.50", "USD")).toEqual({ minor: 10050n, currency: "USD" });
    expect(parseMajor("1000", "JPY")).toEqual({ minor: 1000n, currency: "JPY" });
    expect(parseMajor("100", "USD").minor).toBe(10000n);
    expect(parseMajor("100.5", "USD").minor).toBe(10050n);
    expect(parseMajor("-12.34", "EUR").minor).toBe(-1234n);
    expect(parseMajor("0.001", "BHD").minor).toBe(1n);
    expect(parseMajor("123456789012345678901.99", "USD").minor).toBe(12345678901234567890199n);
  });

  it("rejects too many decimals", () => {
    expect(() => parseMajor("100.505", "USD")).toThrow(MoneyError);
    expect(() => parseMajor("1000.0", "JPY")).toThrow(MoneyError);
    expect(() => parseMajor("1.0001", "BHD")).toThrow(MoneyError);
  });

  it("rejects non-numeric and non-canonical input", () => {
    for (const bad of [
      "",
      " ",
      "abc",
      "1,000.00",
      "1e3",
      "0x10",
      "NaN",
      "Infinity",
      "+1",
      " 1",
      "1 ",
      ".5",
      "1.",
      "01",
      "--1",
      "1.2.3",
    ]) {
      expect(() => parseMajor(bad, "USD"), bad).toThrow(MoneyError);
    }
  });

  it("rejects every negative-zero form", () => {
    for (const bad of ["-0", "-0.0", "-0.00"]) {
      expect(() => parseMajor(bad, "USD"), bad).toThrow(MoneyError);
    }
    expect(() => parseMajor("-0", "JPY")).toThrow(MoneyError);
  });

  it("rejects a currency outside the table", () => {
    expect(() => parseMajor("1", "XXX" as Currency)).toThrow(MoneyError);
    expect(() => money(1n, "XXX" as Currency)).toThrow(MoneyError);
  });

  it("formats canonically", () => {
    expect(formatMajor(money(10050n, "USD"))).toBe("100.50");
    expect(formatMajor(money(5n, "USD"))).toBe("0.05");
    expect(formatMajor(money(-5n, "USD"))).toBe("-0.05");
    expect(formatMajor(money(0n, "USD"))).toBe("0.00");
    expect(formatMajor(money(1000n, "JPY"))).toBe("1000");
    expect(formatMajor(money(1n, "BHD"))).toBe("0.001");
  });

  it("round-trips every currency in the table", () => {
    for (const c of CURRENCIES) {
      for (const minor of [0n, 1n, -1n, 99n, 100n, 10050n, -123456789n, 10n ** 20n]) {
        const m = money(minor, c);
        expect(parseMajor(formatMajor(m), c), `${c} ${minor}`).toEqual(m);
      }
    }
  });
});

describe("arithmetic", () => {
  it("adds, subtracts, compares and negates in one currency", () => {
    const a = money(150n, "USD");
    const b = money(50n, "USD");
    expect(add(a, b).minor).toBe(200n);
    expect(subtract(b, a).minor).toBe(-100n);
    expect(negate(a).minor).toBe(-150n);
    expect(compare(a, b)).toBe(1);
    expect(compare(b, a)).toBe(-1);
    expect(compare(a, a)).toBe(0);
  });

  it("guards against mixed currencies", () => {
    const usd = money(1n, "USD");
    const eur = money(1n, "EUR");
    expect(() => add(usd, eur)).toThrow(CurrencyMismatchError);
    expect(() => subtract(usd, eur)).toThrow(CurrencyMismatchError);
    expect(() => compare(usd, eur)).toThrow(CurrencyMismatchError);
  });
});

describe("allocate", () => {
  it("splits with the remainder on the first parts", () => {
    expect(allocate(money(100n, "USD"), 3).map((m) => m.minor)).toEqual([34n, 33n, 33n]);
    expect(allocate(money(-100n, "USD"), 3).map((m) => m.minor)).toEqual([-34n, -33n, -33n]);
    expect(allocate(money(2n, "USD"), 5).map((m) => m.minor)).toEqual([1n, 1n, 0n, 0n, 0n]);
  });

  it("rejects a non-positive or fractional part count", () => {
    for (const n of [0, -1, 1.5, Number.NaN]) {
      expect(() => allocate(money(1n, "USD"), n)).toThrow(MoneyError);
    }
  });
});

describe("Money properties (1,000 runs each)", () => {
  it("formatMajor(parseMajor(x)) === x for canonical inputs", () => {
    const r = prng(0xc0ffee);
    for (let i = 0; i < RUNS; i++) {
      const c = r.pick(CURRENCIES);
      const canonical = formatMajor(money(r.bigint(24), c));
      expect(formatMajor(parseMajor(canonical, c))).toBe(canonical);
    }
  });

  it("allocate(total, n) sums exactly to total and parts differ by at most one minor unit", () => {
    const r = prng(42);
    for (let i = 0; i < RUNS; i++) {
      const total = money(r.bigint(20), r.pick(CURRENCIES));
      const n = r.int(1, 50);
      const parts = allocate(total, n);
      expect(parts).toHaveLength(n);
      const sum = parts.reduce((acc, p) => add(acc, p), money(0n, total.currency));
      expect(sum).toEqual(total);
      const sorted = parts.map((p) => p.minor).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      expect((sorted.at(-1) ?? 0n) - (sorted[0] ?? 0n) <= 1n).toBe(true);
    }
  });

  it("adding Money of different currencies throws", () => {
    const r = prng(7);
    for (let i = 0; i < RUNS; i++) {
      const a = r.pick(CURRENCIES);
      let b = r.pick(CURRENCIES);
      while (b === a) b = r.pick(CURRENCIES);
      expect(() => add(money(r.bigint(10), a), money(r.bigint(10), b))).toThrow(
        CurrencyMismatchError,
      );
    }
  });
});

describe("MoneySchema (wire form)", () => {
  it("parses the wire form into minor units and back", () => {
    const m = MoneySchema.parse({ amount: "100.50", currency: "USD" });
    expect(m).toEqual({ minor: 10050n, currency: "USD" });
    expect(toMoneyWire(m)).toEqual({ amount: "100.50", currency: "USD" });
  });

  it("rejects bad amounts, unknown currencies and extra keys", () => {
    for (const bad of [
      { amount: "100.505", currency: "USD" },
      { amount: "abc", currency: "USD" },
      { amount: "-0", currency: "USD" },
      { amount: 100, currency: "USD" },
      { amount: "1", currency: "XXX" },
      { amount: "1", currency: "USD", extra: true },
    ]) {
      expect(MoneySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
