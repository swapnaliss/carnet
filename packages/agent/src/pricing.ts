// Model prices (Anthropic list prices at build time), as integer nano-USD per token so cost arithmetic stays exact:
// $0.10 per million tokens is 100 nano-USD per token. Above 100k prompt tokens the price is 5x.

export const MODEL_PRICES = {
  "claude-haiku-5-5": { input: 100, output: 500 },
  "claude-sonnet-5-5": { input: 2_000, output: 10_000 },
} as const;

export type ModelId = keyof typeof MODEL_PRICES;

export const LONG_PROMPT_TOKENS = 100_000;
export const LONG_PROMPT_MULTIPLIER = 5;

export const NANO_PER_USD = 1_000_000_000;

export function isModelId(value: string): value is ModelId {
  return Object.hasOwn(MODEL_PRICES, value);
}

export interface TokenUsage {
  /** Prompt tokens including cache creation and cache reads. */
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export function costNanoUsd(model: ModelId, usage: TokenUsage): number {
  const price = MODEL_PRICES[model];
  const mult = usage.inputTokens > LONG_PROMPT_TOKENS ? LONG_PROMPT_MULTIPLIER : 1;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) * mult;
}

/** The most a call can cost: every prompt token plus `max_tokens` of output. */
export function worstCaseCostNanoUsd(
  model: ModelId,
  inputTokensUpperBound: number,
  maxTokens: number,
): number {
  return costNanoUsd(model, { inputTokens: inputTokensUpperBound, outputTokens: maxTokens });
}

/** Provider usage block → prompt and output tokens (cache tokens count as prompt tokens). */
export function usageOf(usage: unknown): TokenUsage {
  const u = (usage ?? {}) as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  return {
    inputTokens:
      n("input_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens"),
    outputTokens: n("output_tokens"),
  };
}
