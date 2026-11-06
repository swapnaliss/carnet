// Public surface of @carnet/agent: the model-call harness (M2-00). Prompts (M2-02, M2-05, M3-01)
// call the model only through `createHarness(...).callStructured`.
export type { CapDecision, CapName } from "./caps";
export { checkCaps, inputTokensUpperBound, utcDayStart } from "./caps";
export type { ClientOptions, Transport } from "./client";
export { MissingApiKeyError, SDK_MAX_RETRIES, SDK_TIMEOUT_MS } from "./client";
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
