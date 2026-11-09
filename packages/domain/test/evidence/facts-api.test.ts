import { describe, expect, it } from "vitest";
import { applyCorrections, type ExtractedFact, usableFacts } from "../../src/index";

const fact = (over: Partial<ExtractedFact> = {}): ExtractedFact => ({
  key: "total",
  value: "USD 980.00",
  parsed: { type: "amount", minor: "98000", currency: "USD" },
  quote: "Total due: USD 980.00",
  page: 1,
  quote_verified: true,
  needs_confirmation: false,
  issues: [],
  ...over,
});

describe("usableFacts", () => {
  const unverified = fact({ quote_verified: false, issues: ["quote_not_found"] });
  const scan = fact({ quote_verified: false, needs_confirmation: true, issues: ["no_text_layer"] });
  const unparsed = fact({ parsed: null });
  it("a model version yields only verified facts", () => {
    const list = usableFacts({
      status: "EXTRACTED",
      ownerConfirmedBy: null,
      facts: [fact(), unverified, scan, unparsed],
    });
    expect(list).toEqual([fact()]);
  });
  it("an owner-confirmed version yields every fact that parses", () => {
    const list = usableFacts({
      status: "EXTRACTED",
      ownerConfirmedBy: "u1",
      facts: [fact(), unverified, scan, unparsed],
    });
    expect(list).toHaveLength(3);
  });
  it("a failed extraction yields nothing", () => {
    expect(usableFacts({ status: "EXTRACTION_FAILED", ownerConfirmedBy: null, facts: [] })).toEqual(
      [],
    );
  });
});

describe("applyCorrections", () => {
  it("replaces a value, parses it in code, and clears needs_confirmation on the rest", () => {
    const scan = [fact({ quote_verified: false, needs_confirmation: true })];
    const r = applyCorrections("invoice", scan, [{ key: "total", value: "USD 1,000.00" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0]).toMatchObject({
      value: "USD 1,000.00",
      parsed: { type: "amount", minor: "100000", currency: "USD" },
      quote_verified: false,
      needs_confirmation: false,
      issues: ["owner_entered"],
    });
  });
  it("adds a missing key, and confirming without corrections keeps the facts", () => {
    const added = applyCorrections(
      "invoice",
      [fact()],
      [{ key: "invoice_date", value: "5 October 2026" }],
    );
    expect(added.ok && added.facts.map((f) => f.key)).toEqual(["total", "invoice_date"]);
    const same = applyCorrections("invoice", [fact({ needs_confirmation: true })], []);
    expect(same.ok && same.facts[0]?.needs_confirmation).toBe(false);
  });
  it("replaces the nth fact of a repeated key", () => {
    const two = [fact({ key: "credit" }), fact({ key: "credit", value: "USD 2.00" })];
    const r = applyCorrections("statement", two, [{ key: "credit", value: "USD 3.00", index: 1 }]);
    expect(r.ok && r.facts.map((f) => f.value)).toEqual(["USD 980.00", "USD 3.00"]);
  });
  it("rejects an unknown key and an unparseable value", () => {
    const r = applyCorrections(
      "invoice",
      [],
      [
        { key: "approve", value: "yes" },
        { key: "total", value: "lots" },
      ],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.code)).toEqual(["unknown_key", "invalid_value"]);
  });
});
