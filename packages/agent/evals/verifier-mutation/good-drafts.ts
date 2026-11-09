// Hand-written grounded drafts for the dataset (M2-05): what a careful person would write from the
// documents' facts, in the same plain style the prompt asks for. They are the "unmutated grounded
// drafts" the verifier must accept 100%: they check that the verifier is not too strict, independent of
// what the model happened to write in the recorded run. Each cites facts by (document, key).
export interface CuratedDraft {
  readonly id: string;
  readonly case: string;
  readonly answerType: "TEXT" | "ATTACHMENT";
  readonly text: string;
  readonly cites: readonly (readonly [document: string, key: string])[];
  readonly documents?: readonly string[];
}

export const CURATED: readonly CuratedDraft[] = [
  {
    id: "harbor-purpose",
    case: "rfi-set-harbor-r1",
    answerType: "TEXT",
    text: "Invoice INV-HP-2026-0141 from Harbor Print Co. to Northwind Studio Ltd for USD 4,800.00, dated 2026-09-14.",
    cites: [
      ["inv-harbor-001", "invoice_number"],
      ["inv-harbor-001", "supplier"],
      ["inv-harbor-001", "buyer"],
      ["inv-harbor-001", "total"],
      ["inv-harbor-001", "invoice_date"],
    ],
  },
  {
    id: "harbor-terms",
    case: "rfi-set-harbor-r1",
    answerType: "TEXT",
    text: "Buyer pays each invoice within 30 days of the invoice date, under contract CT-NW-HP-2026.",
    cites: [
      ["contract-harbor", "clause_payment_terms"],
      ["contract-harbor", "contract_number"],
    ],
  },
  {
    id: "harbor-beneficiary",
    case: "rfi-set-harbor-r1",
    answerType: "TEXT",
    text: "The beneficiary is Harbor Print Co., account number 000123456781, as stated in the contract.",
    cites: [
      ["inv-harbor-001", "beneficiary"],
      ["inv-harbor-001", "account_number"],
      ["contract-harbor", "clause_beneficiary_account"],
    ],
  },
  {
    id: "harbor-cap",
    case: "rfi-set-harbor-r1",
    answerType: "TEXT",
    text: "Total fees under this contract will not exceed USD 60,000.00.",
    cites: [["contract-harbor", "clause_fee_cap"]],
  },
  {
    id: "lakeside-purpose",
    case: "rfi-set-lakeside-r1",
    answerType: "TEXT",
    text: "Invoice LF-2026-0412 from Lakeside Freight LLC to Northwind Studio Ltd, total due USD 1,320.50, due 2026-10-18.",
    cites: [
      ["inv-lakeside-001", "invoice_number"],
      ["inv-lakeside-001", "supplier"],
      ["inv-lakeside-001", "buyer"],
      ["inv-lakeside-001", "total"],
      ["inv-lakeside-001", "due_date"],
    ],
  },
  {
    id: "rhein-purpose",
    case: "rfi-set-rhein-followup-r1",
    answerType: "TEXT",
    text: "Invoice RD-2026-1180 from Rheinblick Druck GmbH for EUR 7,200.00 under purchase order PO-NW-2026-052.",
    cites: [
      ["inv-rhein-001", "invoice_number"],
      ["inv-rhein-001", "supplier"],
      ["inv-rhein-001", "total"],
      ["inv-rhein-001", "purchase_order"],
    ],
  },
  {
    id: "rhein-relationship",
    case: "rfi-set-rhein-followup-r1",
    answerType: "TEXT",
    text: "Contract CT-NW-RD-2026 is between Northwind Studio Ltd (Buyer) and Rheinblick Druck GmbH (Supplier), effective 2026-02-01.",
    cites: [
      ["contract-rhein", "contract_number"],
      ["contract-rhein", "clause_parties"],
      ["contract-rhein", "clause_effective_date"],
    ],
  },
  {
    id: "nordlicht-relationship",
    case: "rfi-set-nordlicht-scan-r1",
    answerType: "TEXT",
    text: "Contract CT-NW-NL-2026 is between Northwind Studio Ltd (Buyer) and Nordlicht Software GmbH (Supplier), effective 2026-03-01. Scope: Software development and maintenance for the Northwind client portal.",
    cites: [
      ["contract-nordlicht", "contract_number"],
      ["contract-nordlicht", "clause_parties"],
      ["contract-nordlicht", "clause_effective_date"],
      ["contract-nordlicht", "clause_scope"],
    ],
  },
  {
    id: "statement-credit",
    case: "rfi-set-rhein-followup-r1",
    answerType: "TEXT",
    text: "A credit of EUR 8,400.00 from Altstadt Verlag GmbH is dated 2026-10-05, reference NW-INV-2026-018.",
    cites: [["stmt-altstadt-001", "credit"]],
  },
  {
    id: "attach-delivery-note",
    case: "rfi-set-harbor-r1",
    answerType: "ATTACHMENT",
    text: "",
    cites: [],
    documents: ["dn-harbor-001"],
  },
  {
    id: "attach-remittance",
    case: "rfi-set-harbor-r1",
    answerType: "ATTACHMENT",
    text: "",
    cites: [],
    documents: ["remit-brightline-001"],
  },
  {
    id: "attach-statement",
    case: "rfi-set-rhein-followup-r1",
    answerType: "ATTACHMENT",
    text: "",
    cites: [],
    documents: ["stmt-altstadt-001"],
  },
];
