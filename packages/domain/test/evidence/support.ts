// Builders for the evidence tests: facts as M2-02 stores them, linked documents as the rules read them.
import type {
  EvidenceDocument,
  EvidenceInput,
  EvidencePayment,
  ExtractedFact,
  ParsedValue,
} from "../../src/index";

export const text = (
  key: string,
  value: string,
  over: Partial<ExtractedFact> = {},
): ExtractedFact => ({
  key,
  value,
  parsed: { type: "text", text: value },
  quote: value,
  page: 1,
  quote_verified: true,
  needs_confirmation: false,
  issues: [],
  ...over,
});

export const amount = (
  key: string,
  minor: bigint | number,
  currency: string,
  over: Partial<ExtractedFact> = {},
): ExtractedFact => ({
  key,
  value: `${currency} ${minor}`,
  parsed: { type: "amount", minor: String(minor), currency } as ParsedValue,
  quote: `${key}: ${currency} ${minor}`,
  page: 1,
  quote_verified: true,
  needs_confirmation: false,
  issues: [],
  ...over,
});

export const unverified = (fact: ExtractedFact): ExtractedFact => ({
  ...fact,
  quote_verified: false,
  issues: ["quote_not_found"],
});

let n = 0;
export function doc(
  kind: string,
  usable: ExtractedFact[],
  over: Partial<EvidenceDocument> = {},
): EvidenceDocument {
  n += 1;
  const id = over.documentId ?? `doc-${String(n).padStart(4, "0")}`;
  return {
    documentId: id,
    kind,
    label: `${kind}-${id}.pdf`,
    factVersionId: `fv-${id}`,
    usable,
    unusableKeys: [],
    extraction: "done",
    ...over,
  };
}

export const PAYEE = "Harbor Print Co.";
export const payment = (over: Partial<EvidencePayment> = {}): EvidencePayment => ({
  amountMinor: 480_000n,
  currency: "USD",
  payeeName: PAYEE,
  reference: "INV-1",
  ...over,
});

export const invoice = (
  over: { total?: ExtractedFact; supplier?: ExtractedFact; extra?: ExtractedFact[] } = {},
) =>
  doc("invoice", [
    over.total ?? amount("total", 480_000, "USD"),
    over.supplier ?? text("supplier", PAYEE),
    ...(over.extra ?? []),
  ]);

export const contract = (party = `Northwind Studio Ltd (Buyer) and ${PAYEE} (Supplier).`) =>
  doc("contract", [text("clause_parties", party)]);

export const input = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
  payment: payment(),
  documents: [],
  priorPayments: 1,
  policy: { contractRequiredAboveMinor: { USD: 100_000n } },
  ...over,
});
