// The fact-version shapes shared by the API, the repository and the evidence rules (M2-02), and the
// pure owner-correction step. A version is immutable once stored; a correction or a confirmation is a
// new version (n+1).
import { z } from "zod";
import type { ExtractionDocType } from "./fact-schemas";
import {
  type ExtractedFact,
  ExtractedFactSchema,
  isFactVerified,
  valueKindOf,
} from "./fact-schemas";
import { parseFactValue } from "./quote-match";

export const FACT_VERSION_SOURCES = ["model", "owner"] as const;
export const FACT_VERSION_STATUSES = ["EXTRACTED", "EXTRACTION_FAILED"] as const;

export const InjectionFlagSchema = z.strictObject({
  kind: z.string(),
  rule: z.string(),
  match: z.string(),
});

/** One stored version of a document's facts. */
export const FactsVersionSchema = z.strictObject({
  document_id: z.string(),
  version: z.number().int().min(1),
  source: z.enum(FACT_VERSION_SOURCES),
  /** `EXTRACTION_FAILED`: the facts are empty and `failure` says why; never silently empty. */
  status: z.enum(FACT_VERSION_STATUSES),
  failure: z.string().nullable(),
  prompt_version: z.string().nullable(),
  model: z.string().nullable(),
  text_layer: z.boolean(),
  facts: z.array(ExtractedFactSchema),
  quotes: z.array(z.strictObject({ key: z.string(), text: z.string(), page: z.number().int() })),
  /** Every quote in `facts` is verified (false for an empty or image-only version). */
  quotes_verified: z.boolean(),
  owner_confirmed_by: z.string().nullable(),
  injection_flags: z.array(InjectionFlagSchema),
  created_at: z.string(),
});
export type FactsVersion = z.infer<typeof FactsVersionSchema>;

/** The facts the evidence rules may use: the latest version only (see `usableFacts`). */
export const UsableFactsSchema = z.strictObject({
  document_id: z.string(),
  version: z.number().int().min(1),
  /** True when an owner confirmed this version. */
  confirmed: z.boolean(),
  facts: z.array(ExtractedFactSchema),
});
export type UsableFacts = z.infer<typeof UsableFactsSchema>;

export const FactsListResponseSchema = z.strictObject({
  document_id: z.string(),
  /** Newest first. */
  versions: z.array(FactsVersionSchema),
  usable: UsableFactsSchema.nullable(),
});
export type FactsListResponse = z.infer<typeof FactsListResponseSchema>;

export const FactCorrectionSchema = z.strictObject({
  key: z.string().min(1).max(64),
  value: z.string().min(1).max(2000),
  /** Which fact of a repeated key to replace (default 0). A value equal to the count appends. */
  index: z.number().int().min(0).max(50).optional(),
});
export type FactCorrection = z.infer<typeof FactCorrectionSchema>;

export const ConfirmFactsBodySchema = z.strictObject({
  corrections: z.array(FactCorrectionSchema).max(50).optional(),
});
export type ConfirmFactsBody = z.infer<typeof ConfirmFactsBodySchema>;

/**
 * The facts of the latest version that evidence may use. A model version yields only verified facts
 * (quote on the page, value derivable from it, nothing to confirm). A version an owner confirmed yields
 * every fact whose value parses. A failed extraction yields none.
 */
export function usableFacts(v: {
  status: string;
  ownerConfirmedBy: string | null;
  facts: readonly ExtractedFact[];
}): ExtractedFact[] {
  if (v.status !== "EXTRACTED") return [];
  if (v.ownerConfirmedBy !== null) return v.facts.filter((f) => f.parsed !== null);
  return v.facts.filter(isFactVerified);
}

export type CorrectionProblem = {
  index: number;
  code: "unknown_key" | "invalid_value";
  key: string;
};

/**
 * Applies an owner's corrections to a version's facts and marks the result confirmed. A corrected or
 * added fact is `owner_entered` (no quote), the rest keep their quote status with
 * `needs_confirmation` cleared. Returns the problems instead when a correction is not valid.
 */
export function applyCorrections(
  type: ExtractionDocType,
  facts: readonly ExtractedFact[],
  corrections: readonly FactCorrection[],
): { ok: true; facts: ExtractedFact[] } | { ok: false; problems: CorrectionProblem[] } {
  const next: ExtractedFact[] = facts.map((f) => ({ ...f, needs_confirmation: false }));
  const problems: CorrectionProblem[] = [];
  corrections.forEach((c, i) => {
    const kind = valueKindOf(type, c.key);
    if (!kind) {
      problems.push({ index: i, code: "unknown_key", key: c.key });
      return;
    }
    const parsed = parseFactValue(kind, c.value);
    if (!parsed) {
      problems.push({ index: i, code: "invalid_value", key: c.key });
      return;
    }
    const entered: ExtractedFact = {
      key: c.key,
      value: c.value,
      parsed,
      quote: "",
      page: 0,
      quote_verified: false,
      needs_confirmation: false,
      issues: ["owner_entered"],
    };
    const positions = next.flatMap((f, at) => (f.key === c.key ? [at] : []));
    const target = positions[c.index ?? 0];
    if (target !== undefined) next[target] = entered;
    else next.push(entered);
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, facts: next };
}
