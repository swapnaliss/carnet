// Public surface of @carnet/agent: the model-call harness (M2-00). Prompts (M2-02, M2-05, M3-01)
// call the model only through `createHarness(...).callStructured`.
export type { CapDecision, CapName } from "./caps";
export { checkCaps, inputTokensUpperBound, utcDayStart } from "./caps";
export type { ClientOptions, Transport } from "./client";
export { MissingApiKeyError, SDK_MAX_RETRIES, SDK_TIMEOUT_MS } from "./client";
export type {
  ExtractableDocument,
  ExtractionResult,
  ExtractionUsage,
  ExtractParams,
} from "./extraction/extract";
export {
  buildBlocks,
  EXTRACT_MODEL,
  extractDocument,
  FIRST_MAX_TOKENS,
  RETRY_MAX_TOKENS,
} from "./extraction/extract";
export type { ExtractionPrompt } from "./extraction/prompts/index";
export { EXTRACTION_PROMPTS } from "./extraction/prompts/index";
export type { RawFact, TextLayer } from "./extraction/verify-quotes";
export { MIN_TEXT_LAYER_CHARS, readTextLayer, verifyFacts } from "./extraction/verify-quotes";
export type {
  ExtractionStore,
  RunExtractionParams,
  RunExtractionResult,
} from "./extraction/worker-handler";
export { EXTRACTION_RUN_KIND, extractionStep, runExtraction } from "./extraction/worker-handler";
export type { InjectionFlag, InjectionFlagKind } from "./guardrail";
export { composeSystem, scanInjection, UNTRUSTED_DATA_RULE, wrapUntrusted } from "./guardrail";
export type {
  CallOutcome,
  CallOutcomeKind,
  Harness,
  HarnessDeps,
  HarnessLimits,
  LimitName,
  ProviderErrorReason,
  RunHandle,
  StructuredRequest,
} from "./harness";
export { createHarness, DEFAULT_LIMITS, PromptVersionMismatchError } from "./harness";
export type { ModelId, TokenUsage } from "./pricing";
export {
  costNanoUsd,
  isModelId,
  MODEL_PRICES,
  NANO_PER_USD,
  usageOf,
  worstCaseCostNanoUsd,
} from "./pricing";
export {
  canonicalJson,
  jsonSchemaOf,
  promptVersion,
  schemaSubsetViolations,
} from "./prompt-version";
export { inputHash, lookupReplay } from "./replay";
export type {
  AgentFlags,
  HarnessStore,
  NewStepRecord,
  ReplayKey,
  RunRecord,
  StepKey,
  StepOutcome,
  StoredStep,
} from "./store";
export type { ModelBlock } from "./structured";
export type {
  DraftInput,
  DraftParams,
  DraftQuestion,
  DraftResult,
  DraftUsage,
  PriorAnswer,
  UnavailableCode,
} from "./drafting/draft";
export {
  buildDraftBlocks,
  DRAFT_FIRST_MAX_TOKENS,
  DRAFT_MODEL,
  DRAFT_RETRY_MAX_TOKENS,
  DRAFT_RUN_KIND,
  draftRfi,
  renderFacts,
  scanDraftInput,
  timedOutDraft,
} from "./drafting/draft";
export type { DraftingStore, RunDraftingParams, RunDraftingResult } from "./drafting/handler";
export { draftStep, runDraftTimeout, runDrafting } from "./drafting/handler";
export {
  AnswerSchema as DraftAnswerSchema,
  SYSTEM as DRAFT_SYSTEM,
  VERSION as DRAFT_PROMPT_VERSION,
  Schema as DraftSchema,
} from "./drafting/prompts/draft";
