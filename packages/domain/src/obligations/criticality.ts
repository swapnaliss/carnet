// Obligation criticality (M3-01, ADR 0011). 1 = must be paid on time, 3 = can slip. A value counts for
// planning only when a person confirmed it; a model's reading of a contract is a proposal and never
// changes it. Pure: no I/O.
import { quoteOccursOnPage } from "../evidence/quote-match";

export const CRITICALITY_VALUES = [1, 2, 3] as const;
export type CriticalityValue = (typeof CRITICALITY_VALUES)[number];

export function isCriticalityValue(value: unknown): value is CriticalityValue {
  return value === 1 || value === 2 || value === 3;
}

/** What the planner sees: a confirmed value, or `UNCONFIRMED`. Same literal set as the planner's input. */
export type PlanningCriticality = CriticalityValue | "UNCONFIRMED";

export const UNCONFIRMED = "UNCONFIRMED" as const;

/**
 * The criticality the planner may use. A value without a confirming user is not confirmed, whatever the
 * row says. Proposals are never read here. M3-02's rule for `UNCONFIRMED`: it reserves cash like
 * criticality 1 and is never deferred (packages/domain/src/planner/plan.ts).
 */
export function planningCriticality(obligation: {
  readonly criticality: number | null;
  readonly criticalityConfirmedBy: string | null;
}): PlanningCriticality {
  const { criticality, criticalityConfirmedBy } = obligation;
  if (isCriticalityValue(criticality) && criticalityConfirmedBy) return criticality;
  return UNCONFIRMED;
}

export const CRITICALITY_PROPOSAL_STATUSES = [
  "PROPOSED",
  "CONFIRMED",
  "OVERRIDDEN",
  "REJECTED",
] as const;
export type CriticalityProposalStatus = (typeof CRITICALITY_PROPOSAL_STATUSES)[number];

export const CRITICALITY_VERIFIER_RESULTS = ["VERIFIED", "REJECTED"] as const;
export type CriticalityVerifierResult = (typeof CRITICALITY_VERIFIER_RESULTS)[number];

/** Why a proposal was rejected; the owner sees `no supporting clause found` for the clause reasons. */
export const CRITICALITY_REJECT_REASONS = [
  "quote_not_found",
  "page_out_of_range",
  "no_payment_clause",
  "no_clause",
  "no_text_layer",
  "model_unavailable",
] as const;
export type CriticalityRejectReason = (typeof CRITICALITY_REJECT_REASONS)[number];

export const NO_SUPPORTING_CLAUSE = "No supporting clause found";

/** What the owner sees for a rejected proposal. Nothing the model wrote is shown for it. */
export const CRITICALITY_REJECT_MESSAGE: Record<CriticalityRejectReason, string> = {
  quote_not_found: NO_SUPPORTING_CLAUSE,
  page_out_of_range: NO_SUPPORTING_CLAUSE,
  no_payment_clause: NO_SUPPORTING_CLAUSE,
  no_clause: NO_SUPPORTING_CLAUSE,
  no_text_layer:
    "This contract has no readable text, so no proposal was made. Set the criticality yourself.",
  model_unavailable:
    "The proposal could not be made right now. Set the criticality yourself or try again.",
};

/**
 * Words that make a clause about what a late payment costs (late fee, interest, suspension,
 * termination, penalty, default). Deterministic: the model does not decide whether its quote counts.
 */
const CONSEQUENCE =
  /\b(late\s+(payment\s+)?(fees?|charges?)|interests?|suspen\w*|terminat\w*|penalt\w*|default\w*)\b/i;

export function concernsLatePaymentConsequence(quote: string): boolean {
  return CONSEQUENCE.test(quote);
}

export type QuoteVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CriticalityRejectReason };

/**
 * The verifier for a proposal's quote: it occurs verbatim (after the evidence normalisation) on the
 * cited page of the text layer, and it concerns late-payment consequences. Page numbers are 1-based.
 */
export function verifyCriticalityQuote(
  quote: string,
  page: number,
  pages: readonly string[],
): QuoteVerdict {
  const text = Number.isInteger(page) && page >= 1 ? pages[page - 1] : undefined;
  if (text === undefined) return { ok: false, reason: "page_out_of_range" };
  if (!quoteOccursOnPage(quote, text)) return { ok: false, reason: "quote_not_found" };
  if (!concernsLatePaymentConsequence(quote)) return { ok: false, reason: "no_payment_clause" };
  return { ok: true };
}
