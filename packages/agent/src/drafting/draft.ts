// The drafting call (M2-05): one call per RFI round covering every question the model can answer, then
// the pure verifier (@carnet/domain) over every answer. Never throws for a model or provider problem:
// those become NEEDS_OWNER (MODEL_UNAVAILABLE) so the owner can write the answers and the RFI is never
// left in DRAFTING. A question the model cannot be asked (answer_type Carnet does not handle) is never
// sent to it.
import {
  type DraftAnswerInput,
  type DraftVerification,
  extractionTypeOf,
  isSupportedAnswerType,
  needsOwner,
  type ReuseProvenance,
  type SuppliedDocument,
  type SuppliedFact,
  verifyDraft,
} from "@carnet/domain";
import { type InjectionFlag, scanInjection, wrapUntrusted } from "../guardrail";
import type { CallOutcome, Harness, RunHandle } from "../harness";
import type { ModelId } from "../pricing";
import { inputHash } from "../replay";
import type { ModelBlock } from "../structured";
import { Schema, SYSTEM, VERSION } from "./prompts/draft";

export const DRAFT_MODEL: ModelId = "claude-sonnet-5-5";
export const DRAFT_FIRST_MAX_TOKENS = 3_000;
export const DRAFT_RETRY_MAX_TOKENS = 4_096;
export const DRAFT_RUN_KIND = "rfi_draft";

export interface DraftQuestion {
  /** The Carnet question row id (the model echoes it back). */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly comment?: string | null;
  readonly answerType: string;
}

export interface PriorAnswer {
  readonly questionTitle: string;
  readonly text: string;
}

export interface DraftInput {
  readonly questions: readonly DraftQuestion[];
  readonly facts: readonly SuppliedFact[];
  readonly documents: readonly SuppliedDocument[];
  /** Approved earlier answers surfaced by answer memory (M2-06); optional context. */
  readonly priorAnswers?: readonly PriorAnswer[];
}

export interface DraftUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanoUsd: number;
  readonly calls: number;
}

export type UnavailableCode =
  | "AGENTS_DISABLED"
  | "CAP_EXCEEDED"
  | "LIMIT_EXCEEDED"
  | "MODEL_REFUSED"
  | "MODEL_TRUNCATED"
  | "MODEL_ERROR";

export interface DraftResult {
  /**
   * `model`: the model replied; `unavailable`: no usable reply (every answer is NEEDS_OWNER); `reuse`
   * (M3-05): a follow-up round decided entirely from approved answers, no model call.
   */
  readonly kind: "model" | "unavailable" | "reuse";
  readonly promptVersion: string;
  readonly model: string;
  readonly inputHash: string;
  readonly injectionFlags: readonly InjectionFlag[];
  readonly usage: DraftUsage;
  readonly unavailable: { code: UnavailableCode; detail: string } | null;
  /** One entry per question, in the questions' order. */
  readonly results: readonly DraftVerification[];
  /** Follow-up rounds (M3-05): the questions answered from memory, by question id. */
  readonly reuseProvenance?: Readonly<Record<string, ReuseProvenance>>;
}

const NO_USAGE: DraftUsage = { inputTokens: 0, outputTokens: 0, costNanoUsd: 0, calls: 0 };

const emptyAnswer = (questionId: string): DraftAnswerInput => ({
  question_id: questionId,
  status: "cannot_answer",
  text: "",
  citations: [],
  document_ids: [],
});

/** Facts as one line each; the quote is JSON-encoded so a quote with a newline stays on its line. */
export function renderFacts(facts: readonly SuppliedFact[]): string {
  return facts
    .map(
      (f) =>
        `[${f.id}] document=${f.documentId} key=${f.key} page=${f.page} quote=${JSON.stringify(f.quote)}`,
    )
    .join("\n");
}

export function buildDraftBlocks(
  input: DraftInput,
  questions: readonly DraftQuestion[],
): ModelBlock[] {
  const q = questions.map((x) => ({
    question_id: x.id,
    answer_type: x.answerType,
    title: x.title,
    description: x.description,
    ...(x.comment ? { comment: x.comment } : {}),
  }));
  const blocks: ModelBlock[] = [
    {
      type: "text",
      text: "Answer every question in QUESTIONS using only FACTS and DOCUMENTS, following the rules in the system prompt.",
    },
    { type: "text", text: wrapUntrusted("questions", JSON.stringify(q, null, 1)) },
    { type: "text", text: wrapUntrusted("facts", renderFacts(input.facts) || "(no facts)") },
    {
      type: "text",
      text: wrapUntrusted(
        "documents",
        input.documents
          .map(
            (d) =>
              `${d.id} kind=${d.kind}${d.name ? ` name=${JSON.stringify(d.name)}` : ""}${
                d.hasUsableFacts || !extractionTypeOf(d.kind) ? "" : " facts=unverified"
              }`,
          )
          .join("\n") || "(no documents)",
      ),
    },
  ];
  if (input.priorAnswers && input.priorAnswers.length > 0) {
    blocks.push({
      type: "text",
      text: wrapUntrusted(
        "prior_answers",
        input.priorAnswers.map((p) => `${p.questionTitle}: ${p.text}`).join("\n"),
      ),
    });
  }
  return blocks;
}

function unavailableOf(outcome: CallOutcome<unknown>): { code: UnavailableCode; detail: string } {
  switch (outcome.outcome) {
    case "disabled":
      return { code: "AGENTS_DISABLED", detail: "agents_disabled" };
    case "cap_exceeded":
      return { code: "CAP_EXCEEDED", detail: `cap_exceeded:${outcome.cap}` };
    case "limit_exceeded":
      return { code: "LIMIT_EXCEEDED", detail: `limit_exceeded:${outcome.limit}` };
    case "refused":
      return { code: "MODEL_REFUSED", detail: "refused" };
    case "truncated":
      return { code: "MODEL_TRUNCATED", detail: "truncated" };
    case "provider_error":
      return {
        code: "MODEL_ERROR",
        detail: `provider_error:${outcome.reason}${outcome.status ? `:${outcome.status}` : ""}`,
      };
    default:
      return { code: "MODEL_ERROR", detail: outcome.outcome };
  }
}

export function scanDraftInput(input: DraftInput): InjectionFlag[] {
  const text = [
    ...input.questions.flatMap((q) => [q.title, q.description, q.comment ?? ""]),
    ...input.facts.flatMap((f) => [f.quote, f.value]),
    ...(input.priorAnswers ?? []).map((p) => p.text),
  ].join("\n");
  return scanInjection(text);
}

export interface DraftParams {
  readonly harness: Harness;
  readonly run: RunHandle;
  /** The harness question key: new for each deliberate re-draft, stable for a retry of one job. */
  readonly step: string;
  readonly input: DraftInput;
  readonly model?: ModelId;
}

export async function draftRfi(params: DraftParams): Promise<DraftResult> {
  const { harness, run, step, input } = params;
  const model = params.model ?? DRAFT_MODEL;
  const injectionFlags = scanDraftInput(input);

  // Questions of a type Carnet does not handle are never sent to the model.
  const askable = input.questions.filter((q) => isSupportedAnswerType(q.answerType));
  const blocks = buildDraftBlocks(input, askable);
  const hash = inputHash(model, blocks);
  const base = { promptVersion: VERSION, model, inputHash: hash, injectionFlags };

  const unavailable = (
    why: { code: UnavailableCode; detail: string },
    usage: DraftUsage,
  ): DraftResult => ({
    ...base,
    kind: "unavailable",
    usage,
    unavailable: why,
    results: input.questions.map((q) => {
      return {
        question_id: q.id,
        answer: emptyAnswer(q.id),
        verdict: isSupportedAnswerType(q.answerType)
          ? needsOwner("MODEL_UNAVAILABLE", why.detail)
          : needsOwner("UNSUPPORTED_ANSWER_TYPE", q.answerType),
      };
    }),
  });

  if (askable.length === 0) {
    return {
      ...base,
      kind: "model",
      usage: NO_USAGE,
      unavailable: null,
      results: verifyDraft(input.questions, [], input),
    };
  }

  let usage = NO_USAGE;
  const call = async (maxTokens: number) => {
    const outcome = await harness.callStructured({
      run,
      step,
      promptVersion: VERSION,
      model,
      system: SYSTEM,
      blocks,
      schema: Schema,
      maxTokens,
    });
    if (outcome.outcome === "ok") {
      usage = {
        inputTokens: usage.inputTokens + outcome.usage.inputTokens,
        outputTokens: usage.outputTokens + outcome.usage.outputTokens,
        costNanoUsd: usage.costNanoUsd + outcome.costNanoUsd,
        calls: usage.calls + 1,
      };
    }
    return outcome;
  };

  let outcome = await call(DRAFT_FIRST_MAX_TOKENS);
  const retryable =
    outcome.outcome === "truncated" ||
    (outcome.outcome === "provider_error" && outcome.reason === "invalid_output");
  if (retryable) outcome = await call(DRAFT_RETRY_MAX_TOKENS);

  if (outcome.outcome !== "ok" && outcome.outcome !== "replayed") {
    return unavailable(unavailableOf(outcome), usage);
  }
  return {
    ...base,
    kind: "model",
    usage,
    unavailable: null,
    results: verifyDraft(input.questions, outcome.output.answers, input),
  };
}

/** The result for an RFI whose draft never arrived (timeout sweeper): every question NEEDS_OWNER. */
export function timedOutDraft(input: Pick<DraftInput, "questions">): DraftResult {
  const why = { code: "MODEL_ERROR" as const, detail: "draft_timeout" };
  return {
    kind: "unavailable",
    promptVersion: VERSION,
    model: DRAFT_MODEL,
    inputHash: "",
    injectionFlags: [],
    usage: NO_USAGE,
    unavailable: why,
    results: input.questions.map((q) => ({
      question_id: q.id,
      answer: emptyAnswer(q.id),
      verdict: isSupportedAnswerType(q.answerType)
        ? needsOwner("MODEL_UNAVAILABLE", why.detail)
        : needsOwner("UNSUPPORTED_ANSWER_TYPE", q.answerType),
    })),
  };
}
