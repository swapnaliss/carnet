// Follow-up drafting (M3-05). In a follow-up round (round 2 and later) a question whose normalised
// fingerprint matches an answer the owner already approved for this counterparty is NOT sent to the model:
// the remembered answer is checked against today's facts and documents by the same verifier a model draft
// goes through (reuse.ts), and either pre-fills the draft ("Same as approved on <date>") or, when it no
// longer holds, becomes NEEDS_OWNER (REUSE_STALE). Only the questions with no match are drafted by the
// model, through the unchanged M2-05 pipeline. If every question is matched there is no model call at all.
// Reuse is not approval: the owner still gives a fresh, bound approval (ADR 0007, 0008).
// Pure and model-free; nothing here imports the harness or the client.
import type {
  DraftAnswerInput,
  DraftVerification,
  MemoryEntry,
  ReuseProvenance,
} from "@carnet/domain";
import { needsOwner } from "@carnet/domain";
import type { DraftQuestion, DraftResult } from "../drafting/draft";
import { type ReuseContext, resolveReuse } from "../drafting/reuse";

/** Stored as the draft's prompt version when no model was involved. */
export const REUSE_PROMPT_VERSION = "reuse@1";

export interface FollowUpReuse {
  /** Approved answers for this round's questions, by Carnet question id (exact fingerprint match only). */
  readonly matches: ReadonlyMap<string, MemoryEntry>;
  readonly context: ReuseContext;
}

export interface FollowUpPlan {
  /** Reused or stale: decided without the model. */
  readonly local: readonly DraftVerification[];
  readonly provenance: Readonly<Record<string, ReuseProvenance>>;
  /** Questions with no remembered answer: these (and only these) go to the model. */
  readonly toModel: readonly DraftQuestion[];
}

const emptyAnswer = (questionId: string): DraftAnswerInput => ({
  question_id: questionId,
  status: "cannot_answer",
  text: "",
  citations: [],
  document_ids: [],
});

export function planFollowUp(
  questions: readonly DraftQuestion[],
  reuse: FollowUpReuse,
): FollowUpPlan {
  const results = resolveReuse(
    questions.map((q) => ({ id: q.id, answerType: q.answerType })),
    reuse.matches,
    reuse.context,
  );
  const local: DraftVerification[] = [];
  const provenance: Record<string, ReuseProvenance> = {};
  const toModel: DraftQuestion[] = [];
  results.forEach((r, i) => {
    const question = questions[i];
    if (!question) return;
    if (r.kind === "none") {
      toModel.push(question);
    } else if (r.kind === "reused") {
      provenance[r.question_id] = r.provenance;
      local.push({ question_id: r.question_id, answer: r.answer, verdict: r.verdict });
    } else {
      provenance[r.question_id] = r.provenance;
      local.push({
        question_id: r.question_id,
        answer: emptyAnswer(r.question_id),
        verdict: r.verdict.status === "NEEDS_OWNER" ? r.verdict : needsOwner("REUSE_STALE"),
      });
    }
  });
  return { local, provenance, toModel };
}

/** The draft for a round in which every question was decided locally: no model call was made. */
export function reuseOnlyResult(plan: FollowUpPlan): DraftResult {
  return {
    kind: "reuse",
    promptVersion: REUSE_PROMPT_VERSION,
    model: "none",
    inputHash: "",
    injectionFlags: [],
    usage: { inputTokens: 0, outputTokens: 0, costNanoUsd: 0, calls: 0 },
    unavailable: null,
    results: plan.local,
    reuseProvenance: plan.provenance,
  };
}

/** The model's draft for the unmatched questions plus the locally decided ones, in question order. */
export function combineFollowUp(
  questions: readonly DraftQuestion[],
  plan: FollowUpPlan,
  modelResult: DraftResult,
): DraftResult {
  const byId = new Map<string, DraftVerification>();
  for (const r of [...modelResult.results, ...plan.local]) byId.set(r.question_id, r);
  return {
    ...modelResult,
    results: questions.flatMap((q) => {
      const r = byId.get(q.id);
      return r ? [r] : [];
    }),
    reuseProvenance: { ...modelResult.reuseProvenance, ...plan.provenance },
  };
}
