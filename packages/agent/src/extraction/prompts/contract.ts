import { buildPrompt } from "./common";

export const contractPrompt = buildPrompt(
  "contract",
  "The document is a contract between a buyer and a supplier. Clauses are numbered; for a clause key, the value is the clause text after its number and label, copied word for word, and the quote is the whole numbered clause line.",
  {
    contract_number: "the contract number",
    clause_parties: "the clause naming the parties",
    clause_effective_date: "the date the contract takes effect",
    clause_term_end: "the date the contract ends, when stated",
    clause_scope: "the clause describing the scope of work or goods",
    clause_payment_terms: "the clause on when invoices are paid",
    clause_fee_cap: "the clause that limits or sets the fees or amounts payable",
    clause_beneficiary_account: "the clause naming the account the supplier is paid to",
    clause_governing_law: "the clause naming the governing law",
    clause_signatories: "the people or roles who signed, when stated",
  },
);
