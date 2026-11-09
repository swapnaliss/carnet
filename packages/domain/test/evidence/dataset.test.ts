// M2-03: the flags for the dataset's payments (fixtures/dataset/ground-truth.json). The document facts
// are the dataset's ground-truth facts, which M2-02's replay eval shows the extraction reproduces
// (106/106 fields, every text-PDF quote verified); an image-only document has none usable until an
// owner confirms it. Expected flags follow the dataset's cases:
//   contradict (pay-006): WEAK evidence (conflict); missing-contract (pay-003): the contract is absent;
//   image-only (pay-008): no fact is used until the owner confirms.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkEvidence,
  type EvidenceDocument,
  type EvidenceFlag,
  type ExtractedFact,
  type ParsedValue,
} from "../../src/index";

interface GtFact {
  field: string;
  value: string | { amountMinor: number; currency: string };
  quote: string;
  page: number;
}
interface GtDoc {
  id: string;
  kind: string;
  textLayer: boolean;
  facts: GtFact[];
}
interface GtPayment {
  id: string;
  counterpartyId: string;
  amountMinor: number;
  currency: string;
  supportingDocumentIds: string[];
}
const truth = JSON.parse(
  readFileSync(new URL("../../../../fixtures/dataset/ground-truth.json", import.meta.url), "utf8"),
) as { documents: GtDoc[]; payments: GtPayment[] };
const counterparties = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/dataset/counterparties.json", import.meta.url),
    "utf8",
  ),
) as { counterparties: { id: string; name: string }[] };

const KIND: Record<string, string> = {
  contract: "contract",
  invoice: "invoice",
  purchase_order: "purchase_order",
};

function parsed(f: GtFact): ParsedValue {
  if (typeof f.value === "object") {
    return {
      type: "amount",
      minor: String(f.value.amountMinor),
      currency: f.value.currency,
    } as ParsedValue;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.value)) return { type: "date", date: f.value };
  return { type: "text", text: f.value };
}

function toDocument(d: GtDoc, confirmed = false): EvidenceDocument {
  const facts: ExtractedFact[] = d.facts.map((f) => ({
    key: f.field,
    value: typeof f.value === "object" ? `${f.value.currency} ${f.value.amountMinor}` : f.value,
    parsed: parsed(f),
    quote: f.quote,
    page: f.page,
    quote_verified: d.textLayer,
    needs_confirmation: !d.textLayer && !confirmed,
    issues: d.textLayer ? [] : confirmed ? [] : ["no_text_layer"],
  }));
  const usable = d.textLayer || confirmed ? facts : [];
  return {
    documentId: d.id,
    kind: KIND[d.kind] ?? "other",
    label: `${d.id}.pdf`,
    factVersionId: `fv-${d.id}`,
    usable,
    unusableKeys: usable.length === 0 ? facts.map((f) => f.key) : [],
    extraction: "done",
  };
}

function flagOf(paymentId: string, confirmed: string[] = []) {
  const idx = truth.payments.findIndex((p) => p.id === paymentId);
  const p = truth.payments[idx];
  if (!p) throw new Error(`no payment ${paymentId}`);
  const payee = counterparties.counterparties.find((c) => c.id === p.counterpartyId)?.name ?? "";
  const docs = p.supportingDocumentIds.flatMap((id) => {
    const d = truth.documents.find((x) => x.id === id);
    return d ? [toDocument(d, confirmed.includes(id))] : [];
  });
  return checkEvidence({
    payment: {
      amountMinor: BigInt(p.amountMinor),
      currency: p.currency,
      payeeName: payee,
      reference: p.id,
    },
    documents: docs,
    priorPayments: truth.payments.slice(0, idx).filter((q) => q.counterpartyId === p.counterpartyId)
      .length,
    policy: { contractRequiredAboveMinor: {} },
  });
}

describe("dataset payments", () => {
  const expected: [string, EvidenceFlag][] = [
    ["pay-001", "strong"],
    ["pay-002", "strong"],
    ["pay-003", "missing"], // no contract exists for Lakeside; first payment above the threshold
    ["pay-004", "strong"], // injected instruction is data; the visible facts agree
    ["pay-005", "strong"],
    ["pay-006", "weak"], // invoice EUR 9,450.00 against PO EUR 6,900.00 and another IBAN
    ["pay-007", "strong"],
    ["pay-008", "weak"], // scan: nothing usable until confirmed
  ];
  it.each(expected)("%s -> %s", (id, flag) => {
    expect(flagOf(id).flag).toBe(flag);
  });

  it("covers at least one Strong, one Weak and one Missing", () => {
    const flags = new Set(expected.map(([id]) => flagOf(id).flag));
    expect([...flags].sort()).toEqual(["missing", "strong", "weak"]);
  });

  it("pay-006 names both conflicts, with both values", () => {
    const keys = flagOf("pay-006").reasons.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining(["totalsDiffer", "accountsDiffer"]));
    const differ = flagOf("pay-006").reasons.find((r) => r.key === "totalsDiffer");
    expect(differ?.params).toMatchObject({
      invoice: "EUR 9,450.00",
      purchaseOrder: "EUR 6,900.00",
    });
  });

  it("pay-008 becomes Strong only after the owner confirms the scan", () => {
    const before = flagOf("pay-008");
    expect(before.flag).toBe("weak");
    expect(before.rules.find((r) => r.rule === "R-AMT")?.outcome).not.toBe("pass");
    expect(flagOf("pay-008", ["inv-nordlicht-scan-001"]).flag).toBe("strong");
  });
});
