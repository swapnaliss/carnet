// M2-02 AC2: quote verification against the PDF text layer, and the mutation test.
import { describe, expect, it } from "vitest";
import { readTextLayer, verifyFacts } from "../../src/index";
import { caseById, documentOf } from "./support";

const layerOf = async (id: string) => readTextLayer(documentOf(caseById(id)).bytes);

describe("readTextLayer", () => {
  it("reads one string per page", async () => {
    const layer = await layerOf("contract-harbor");
    expect(layer?.pages).toHaveLength(2);
    expect(layer?.pages[1]).toContain("Governing law");
  });
  it("returns null for a PDF with no text layer", async () => {
    expect(await layerOf("inv-nordlicht-scan-001")).toBeNull();
  });
  it("returns null for garbage bytes", async () => {
    expect(await readTextLayer(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe("verifyFacts", () => {
  const good = {
    key: "invoice_number",
    value: "LF-2026-0455",
    quote: "Invoice number: LF-2026-0455",
    page: 1,
  };
  it("verifies a verbatim quote with a derivable value", async () => {
    const layer = await layerOf("inv-lakeside-002");
    const [f] = verifyFacts("invoice", [good], layer);
    expect(f).toMatchObject({ quote_verified: true, needs_confirmation: false, issues: [] });
  });
  it("marks a quote altered by one word, on a different page, or invented as unverified", async () => {
    const layer = await layerOf("inv-lakeside-002");
    const mutated = verifyFacts(
      "invoice",
      [
        { ...good, quote: "Invoice no: LF-2026-0455" },
        { ...good, page: 2 },
        { ...good, page: 0 },
        { ...good, quote: "Reference: ZX-1" },
      ],
      layer,
    );
    expect(mutated.map((f) => f.quote_verified)).toEqual([false, false, false, false]);
    expect(mutated[0]?.issues).toContain("quote_not_found");
    expect(mutated[1]?.issues).toContain("page_out_of_range");
  });
  it("a quote on the wrong page of a two-page contract is unverified", async () => {
    const layer = await layerOf("contract-harbor");
    const [onPage1] = verifyFacts(
      "contract",
      [
        {
          key: "clause_governing_law",
          value: "The laws of the Netherlands apply.",
          quote: "7. Governing law: The laws of the Netherlands apply.",
          page: 1,
        },
      ],
      layer,
    );
    expect(onPage1?.quote_verified).toBe(false);
  });
  it("rejects a value that the quote does not state, even when the quote is real", async () => {
    const layer = await layerOf("inv-lakeside-002");
    const [wrongNumber, wrongAmount] = verifyFacts(
      "invoice",
      [
        { ...good, value: "LF-2026-9999" },
        { key: "total", value: "USD 9,800.00", quote: "Total due: USD 980.00", page: 1 },
      ],
      layer,
    );
    expect(wrongNumber?.issues).toContain("value_not_in_quote");
    expect(wrongAmount?.issues).toContain("value_not_in_quote");
    expect(wrongAmount?.quote_verified).toBe(false);
  });
  it("flags an unparseable value", async () => {
    const layer = await layerOf("inv-lakeside-002");
    const [f] = verifyFacts(
      "invoice",
      [{ key: "total", value: "980", quote: "Total due: USD 980.00", page: 1 }],
      layer,
    );
    expect(f?.issues).toContain("unparseable_value");
    expect(f?.parsed).toBeNull();
    expect(f?.quote_verified).toBe(false);
  });
  it("without a text layer every fact needs confirmation and none is verified", () => {
    const [f] = verifyFacts("invoice", [good], null);
    expect(f).toMatchObject({ quote_verified: false, needs_confirmation: true });
    expect(f?.issues).toContain("no_text_layer");
  });
});
