import { describe, expect, it } from "vitest";
import {
  DOCUMENT_KINDS,
  EXTRACTION_DOC_TYPES,
  extractionOutputSchema,
  extractionTypeOf,
  FACT_KEYS,
  valueKindOf,
} from "../../src/index";

describe("fact schemas", () => {
  it("has a schema for every document kind except other", () => {
    for (const kind of DOCUMENT_KINDS) {
      expect(extractionTypeOf(kind) !== null).toBe(kind !== "other");
    }
    expect([...EXTRACTION_DOC_TYPES]).toEqual([
      "invoice",
      "contract",
      "purchase_order",
      "statement",
    ]);
  });
  it("accepts only the type's own keys", () => {
    const schema = extractionOutputSchema("invoice");
    const fact = { key: "total", value: "USD 1.00", quote: "Total: USD 1.00", page: 1 };
    expect(schema.safeParse({ facts: [fact] }).success).toBe(true);
    expect(schema.safeParse({ facts: [{ ...fact, key: "clause_fee_cap" }] }).success).toBe(false);
    expect(schema.safeParse({ facts: [{ ...fact, key: "instruction" }] }).success).toBe(false);
    expect(schema.safeParse({ facts: [fact], note: "extra" }).success).toBe(true);
  });
  it("gives every key a value kind", () => {
    expect(valueKindOf("invoice", "total")).toBe("amount");
    expect(valueKindOf("contract", "clause_effective_date")).toBe("date");
    expect(valueKindOf("statement", "payer")).toBe("text");
    expect(valueKindOf("invoice", "nope")).toBeNull();
    for (const keys of Object.values(FACT_KEYS))
      expect(Object.keys(keys).length).toBeGreaterThan(3);
  });
});
