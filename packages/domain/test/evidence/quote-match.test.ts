// M2-02: quote normalisation and matching, and amount/date parsing (pure).
import { describe, expect, it } from "vitest";
import {
  findAmounts,
  findDates,
  normalizeText,
  parseAmountValue,
  parseDateValue,
  parseFactValue,
  quoteOccursOnPage,
  valueSupportedByQuote,
} from "../../src/index";

describe("normalizeText", () => {
  it("collapses whitespace, normalises Unicode form and removes invisible characters", () => {
    expect(normalizeText("  Total \n due:\t USD\u{a0}980.00 ")).toBe("Total due: USD 980.00");
    expect(normalizeText("Cafe\u{301}")).toBe("Caf\u{e9}");
    expect(normalizeText("ab\u{200b}c\u{ad}d")).toBe("abcd");
    expect(normalizeText("\u{fb01}nal")).toBe("final");
  });
  it("re-joins a word split by a hyphen at a line break, and unifies dashes and quotes", () => {
    expect(normalizeText("pay-\nment terms")).toBe("payment terms");
    expect(normalizeText("Net 30 \u{2013} days \u{201c}x\u{201d} \u{2019}")).toBe(
      'Net 30 - days "x" \'',
    );
  });
  it("is idempotent and keeps case", () => {
    const once = normalizeText("A  B\n\nC-\nd");
    expect(normalizeText(once)).toBe(once);
    expect(normalizeText("Acme")).not.toBe(normalizeText("ACME"));
  });
});

describe("quoteOccursOnPage", () => {
  const page =
    "INVOICE\nInvoice number: LF-2026-0455\nInvoice date: 2026-10-05\nTotal due: USD 980.00";
  it("finds a verbatim quote across line and spacing differences", () => {
    expect(quoteOccursOnPage("Invoice number: LF-2026-0455", page)).toBe(true);
    expect(quoteOccursOnPage("Invoice date:  2026-10-05\nTotal due: USD 980.00", page)).toBe(true);
  });
  it("rejects a quote that differs by one word, one digit or one capital, and an empty quote", () => {
    expect(quoteOccursOnPage("Invoice number: LF-2026-0456", page)).toBe(false);
    expect(quoteOccursOnPage("Invoice no: LF-2026-0455", page)).toBe(false);
    expect(quoteOccursOnPage("invoice number: LF-2026-0455", page)).toBe(false);
    expect(quoteOccursOnPage("   ", page)).toBe(false);
  });
  it("accepts a hyphenated wrap quoted with or without the hyphen", () => {
    expect(quoteOccursOnPage("payment terms", "pay-\nment terms apply")).toBe(true);
    expect(quoteOccursOnPage("co-operate", "co-\noperate fully")).toBe(true);
  });
});

describe("amounts", () => {
  it("parses English and European notation to minor units", () => {
    expect(findAmounts("Total due: USD 4,800.00")).toEqual([{ minor: 480000n, currency: "USD" }]);
    expect(findAmounts("Gesamt EUR 7.200,00")).toEqual([{ minor: 720000n, currency: "EUR" }]);
    expect(findAmounts("Total 1\u{202f}250,50 EUR")).toEqual([{ minor: 125050n, currency: "EUR" }]);
    expect(findAmounts("Amount paid: USD 12,500.00")).toEqual([
      { minor: 1250000n, currency: "USD" },
    ]);
    expect(findAmounts("Fee \u{20ac}980")).toEqual([{ minor: 98000n, currency: "EUR" }]);
    expect(findAmounts("JPY 1,200")).toEqual([{ minor: 1200n, currency: "JPY" }]);
  });
  it("ignores numbers without a currency and keeps several amounts in order", () => {
    expect(findAmounts("Invoice 2026 line 1")).toEqual([]);
    expect(findAmounts("USD 10.00 and EUR 5.50").map((a) => a.minor)).toEqual([1000n, 550n]);
  });
  it("accepts a value only when it is exactly one amount", () => {
    expect(parseAmountValue("USD 980.00")).toEqual({ minor: 98000n, currency: "USD" });
    expect(parseAmountValue("980.00")).toBeNull();
    expect(parseAmountValue("about USD 980.00")).toBeNull();
    expect(parseAmountValue("USD 10.00 / EUR 9.00")).toBeNull();
  });
});

describe("dates", () => {
  it("reads ISO, European and written dates", () => {
    expect(findDates("Invoice date: 2026-10-05")).toEqual(["2026-10-05"]);
    expect(findDates("05.10.2026")).toEqual(["2026-10-05"]);
    expect(findDates("5 October 2026, then Nov 3, 2026")).toEqual(["2026-10-05", "2026-11-03"]);
    expect(findDates("2026-02-30")).toEqual([]);
  });
  it("accepts a value only when it is exactly one date", () => {
    expect(parseDateValue("2026-01-15.")).toBe("2026-01-15");
    expect(parseDateValue("15 January 2026")).toBe("2026-01-15");
    expect(parseDateValue("due on 2026-01-15")).toBeNull();
    expect(parseDateValue("2026-13-01")).toBeNull();
  });
});

describe("values against quotes", () => {
  it("matches amounts and dates by parsed value, not substring", () => {
    const amount = parseFactValue("amount", "USD 4800.00");
    expect(amount).toEqual({ type: "amount", minor: "480000", currency: "USD" });
    if (!amount) throw new Error("unreachable");
    expect(valueSupportedByQuote(amount, "Order total: USD 4,800.00")).toBe(true);
    expect(valueSupportedByQuote(amount, "Order total: USD 48,000.00")).toBe(false);
    expect(valueSupportedByQuote(amount, "Order total: EUR 4,800.00")).toBe(false);
    const date = parseFactValue("date", "2026-10-05");
    if (!date) throw new Error("unreachable");
    expect(valueSupportedByQuote(date, "Invoice date: 5 October 2026")).toBe(true);
    expect(valueSupportedByQuote(date, "Invoice date: 2026-10-06")).toBe(false);
  });
  it("requires a text value to occur in its quote", () => {
    const t = parseFactValue("text", "Harbor Print Co.");
    if (!t) throw new Error("unreachable");
    expect(valueSupportedByQuote(t, "Supplier: Harbor Print Co.")).toBe(true);
    expect(valueSupportedByQuote(t, "Supplier: Lakeside Freight LLC")).toBe(false);
  });
  it("returns null for a value that is not its kind", () => {
    expect(parseFactValue("date", "soon")).toBeNull();
    expect(parseFactValue("amount", "lots")).toBeNull();
    expect(parseFactValue("text", "   ")).toBeNull();
  });
});
