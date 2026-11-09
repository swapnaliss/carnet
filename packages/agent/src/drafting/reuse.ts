// Answer reuse (M2-06, architecture §13). Pure and model-free: this module takes remembered, approved
// answers (matched on an exact fingerprint by the repository) and checks them against the business's
// CURRENT facts and documents with the same verifier a model draft goes through (M2-05). Reuse saves
// typing, it does not bypass the checks: a remembered answer whose cited facts changed, or whose
// attached document is gone or replaced, becomes NEEDS_OWNER (`REUSE_STALE`) instead of being reused.
// Nothing here imports the harness or the model client, and the tests spy the transport to prove it.
import {
  type AnswerVerdict,
  type DraftAnswerInput,
  type MemoryEntry,
  needsOwner,
  normalizeText,
  provenanceOf,
  type ReuseProvenance,
  type SuppliedFact,
  type VerifierContext,
  type VerifierQuestion,
  verifyAnswer,
} from "@carnet/domain";
import type { PriorAnswer } from "./draft";

/** What the current evidence is, for reuse: the verifier's context plus each document's SHA-256. */
export interface ReuseContext extends VerifierContext {
  /** Lower-case hex SHA-256 of each document of the business, by document id. */
  readonly documentHashes: ReadonlyMap<string, string>;
}

export type ReuseResult =
  /** The remembered answer holds against today's facts: pre-fill it (still needs a new approval). */
  | {
      readonly kind: "reused";
      readonly question_id: string;
      readonly answer: DraftAnswerInput;
      readonly verdict: AnswerVerdict;
      readonly provenance: ReuseProvenance;
    }
  /** A remembered answer exists but no longer holds: NEEDS_OWNER, reason `REUSE_STALE`. */
  | {
      readonly kind: "stale";
      readonly question_id: string;
      readonly verdict: AnswerVerdict;
      readonly provenance: ReuseProvenance;
    }
  | { readonly kind: "none"; readonly question_id: string };

const stale = (detail: string): AnswerVerdict => needsOwner("REUSE_STALE", detail);

/**
 * A remembered citation, pointed at today's fact. The fact must still say the same thing: same version id
 * and quote, or (a newer facts version that did not change this field) the same document, key and quote.
 * Null when the fact is gone or its quote changed.
 */
export function rebindCitation(
  cited: MemoryEntry["citations"][number],
  facts: readonly SuppliedFact[],
): SuppliedFact | null {
  const quote = normalizeText(cited.quote);
  const same = (f: SuppliedFact) => normalizeText(f.quote) === quote;
  const exact = facts.find((f) => f.id === cited.fact_version_id);
  if (exact) return same(exact) ? exact : null;
  return (
    facts.find((f) => f.documentId === cited.document_id && f.key === cited.key && same(f)) ?? null
  );
}

/** One question: the remembered answer against the current facts and documents. */
export function reuseAnswer(
  question: VerifierQuestion,
  entry: MemoryEntry,
  ctx: ReuseContext,
): ReuseResult {
  const provenance = provenanceOf(entry);
  const base = { question_id: question.id, provenance } as const;

  const citations: { fact_version_id: string; quote: string }[] = [];
  for (const cited of entry.citations) {
    const fact = rebindCitation(cited, ctx.facts);
    if (!fact) return { kind: "stale", ...base, verdict: stale(`fact ${cited.fact_version_id}`) };
    citations.push({ fact_version_id: fact.id, quote: fact.quote });
  }
  for (const attached of entry.attachments) {
    if (ctx.documentHashes.get(attached.document_id) !== attached.sha256) {
      return { kind: "stale", ...base, verdict: stale(`document ${attached.document_id}`) };
    }
  }
  const answer: DraftAnswerInput = {
    question_id: question.id,
    status: "answered",
    text: entry.answerText,
    citations,
    document_ids: entry.attachments.map((a) => a.document_id),
  };
  // An approved answer that cited nothing was the owner's own words: it stays "owner authored".
  const verdict = verifyAnswer(question, answer, ctx, {
    ownerAuthored: entry.citations.length === 0,
  });
  if (verdict.status === "NEEDS_OWNER") {
    return { kind: "stale", ...base, verdict: stale(verdict.reason ?? "unverified") };
  }
  return { kind: "reused", ...base, answer, verdict };
}

/** Every question of a round: reused, stale, or none (no remembered answer). Question order is kept. */
export function resolveReuse(
  questions: readonly VerifierQuestion[],
  matches: ReadonlyMap<string, MemoryEntry>,
  ctx: ReuseContext,
): ReuseResult[] {
  return questions.map((q) => {
    const entry = matches.get(q.id);
    return entry ? reuseAnswer(q, entry, ctx) : { kind: "none", question_id: q.id };
  });
}

/** Earlier approved answers as context for the model draft (untrusted data; every claim still needs a citation). */
export function priorAnswersFor(
  questions: readonly { id: string; title: string }[],
  matches: ReadonlyMap<string, MemoryEntry>,
): PriorAnswer[] {
  return questions.flatMap((q) => {
    const entry = matches.get(q.id);
    return entry ? [{ questionTitle: q.title, text: entry.answerText }] : [];
  });
}

/**
 * The questions whose model-written, verified answer is word for word the remembered one: the draft marks
 * them `reused_from` that approval. A different wording, or an answer that failed the verifier, is not.
 */
export function reusedFrom(
  results: readonly { question_id: string; answer: DraftAnswerInput; verdict: AnswerVerdict }[],
  matches: ReadonlyMap<string, MemoryEntry>,
): Map<string, ReuseProvenance> {
  const out = new Map<string, ReuseProvenance>();
  for (const r of results) {
    const entry = matches.get(r.question_id);
    if (entry && r.verdict.status !== "NEEDS_OWNER" && r.answer.text === entry.answerText) {
      out.set(r.question_id, provenanceOf(entry));
    }
  }
  return out;
}
