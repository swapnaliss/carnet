// Per-type extraction schemas (M2-02, ADR 0010). The model returns a flat list of facts; every fact is
// `{key, value, quote, page}` and the keys are a closed set per document type, so the output has no
// field in which an instruction could act. Amounts and dates are parsed in code (quote-match.ts).
import { z } from "zod";
import type { FactValueKind, ParsedValue } from "./quote-match";

export const EXTRACTION_DOC_TYPES = ["invoice", "contract", "purchase_order", "statement"] as const;
export type ExtractionDocType = (typeof EXTRACTION_DOC_TYPES)[number];
export const ExtractionDocTypeSchema = z.enum(EXTRACTION_DOC_TYPES);

/** Fact keys per document type, with the kind of value each holds. */
export const FACT_KEYS = {
  invoice: {
    invoice_number: "text",
    invoice_date: "date",
    due_date: "date",
    supplier: "text",
    buyer: "text",
    total: "amount",
    line_item_total: "amount",
    beneficiary: "text",
    account_number: "text",
    iban: "text",
    bank_reference: "text",
    purchase_order: "text",
  },
  contract: {
    contract_number: "text",
    clause_parties: "text",
    clause_effective_date: "date",
    clause_term_end: "date",
    clause_scope: "text",
    clause_payment_terms: "text",
    clause_fee_cap: "text",
    clause_beneficiary_account: "text",
    clause_governing_law: "text",
    clause_signatories: "text",
  },
  purchase_order: {
    purchase_order: "text",
    order_date: "date",
    buyer: "text",
    supplier: "text",
    total: "amount",
    account_number: "text",
    iban: "text",
  },
  statement: {
    account_holder: "text",
    period_start: "date",
    period_end: "date",
    opening_balance: "amount",
    closing_balance: "amount",
    credit: "amount",
    payer: "text",
  },
} as const satisfies Record<ExtractionDocType, Record<string, FactValueKind>>;

export function factKeysOf(type: ExtractionDocType): readonly [string, ...string[]] {
  return Object.keys(FACT_KEYS[type]) as [string, ...string[]];
}

export function valueKindOf(type: ExtractionDocType, key: string): FactValueKind | null {
  const kinds = FACT_KEYS[type] as Record<string, FactValueKind>;
  return kinds[key] ?? null;
}

/** The document kinds (DOCUMENT_KINDS) that have an extraction schema; `other` has none. */
export function extractionTypeOf(kind: string): ExtractionDocType | null {
  return (EXTRACTION_DOC_TYPES as readonly string[]).includes(kind)
    ? (kind as ExtractionDocType)
    : null;
}

/** What the model returns for one document type (the structured-output schema). */
export function extractionOutputSchema(type: ExtractionDocType) {
  return z.object({
    facts: z.array(
      z.object({
        key: z.enum(factKeysOf(type)),
        value: z.string(),
        quote: z.string(),
        page: z.number().int(),
      }),
    ),
  });
}
export type ExtractionOutput = z.infer<ReturnType<typeof extractionOutputSchema>>;

export const FACT_ISSUES = [
  "quote_not_found",
  "page_out_of_range",
  "value_not_in_quote",
  "unparseable_value",
  "no_text_layer",
  "owner_entered",
] as const;
export type FactIssue = (typeof FACT_ISSUES)[number];

export const ParsedValueSchema: z.ZodType<ParsedValue> = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("date"), date: z.string() }),
  z.object({ type: z.literal("amount"), minor: z.string(), currency: z.string() }),
]) as z.ZodType<ParsedValue>;

/** A fact as stored in `document_facts.facts` and returned by the API. */
export const ExtractedFactSchema = z.strictObject({
  key: z.string().min(1).max(64),
  value: z.string().max(2000),
  /** Null when the value is not a valid value of the key's kind (the fact is then unusable). */
  parsed: ParsedValueSchema.nullable(),
  quote: z.string().max(4000),
  page: z.number().int().min(0),
  /** The quote occurs on the page and the value is derivable from it: set by code only. */
  quote_verified: z.boolean(),
  /** An image-only document, or an owner entry: no fact is usable until an owner confirms. */
  needs_confirmation: z.boolean(),
  issues: z.array(z.enum(FACT_ISSUES)),
});
export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;

/** A fact the evidence rules may use on its own: grounded in the document, nothing to confirm. */
export function isFactVerified(fact: ExtractedFact): boolean {
  return fact.quote_verified && !fact.needs_confirmation && fact.parsed !== null;
}

/** Why a version is `EXTRACTION_FAILED` (its `failure` column). */
export const EXTRACTION_FAILURE_CODES = [
  "AGENTS_DISABLED",
  "CAP_EXCEEDED",
  "LIMIT_EXCEEDED",
  "MODEL_REFUSED",
  "MODEL_TRUNCATED",
  "MODEL_ERROR",
  "UNSUPPORTED_KIND",
] as const;
export type ExtractionFailureCode = (typeof EXTRACTION_FAILURE_CODES)[number];
