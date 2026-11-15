// Spend caps (architecture §10). Before a call the harness prices its worst case (every prompt token
// plus `max_tokens` of output at the model's price) and refuses when the run or the UTC day would
// pass its cap. The actual cost from the usage block is recorded after the call. A refusal writes
// nothing, so the counters are unchanged.
import type { ModelBlock } from "./structured";

export type CapName = "per_run" | "daily" | "session";

export type CapDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly cap: CapName;
      readonly worstCaseNanoUsd: number;
      readonly remainingNanoUsd: number;
    };

export interface CapInput {
  readonly perRunCapNanoUsd: number;
  readonly dailyCapNanoUsd: number;
  readonly runSpentNanoUsd: number;
  readonly daySpentNanoUsd: number;
  readonly worstCaseNanoUsd: number;
  /** M4-05: the queuing web session's cap and spend (SESSION_MODEL_CAP_USD); absent for webhook work. */
  readonly session?: { readonly capNanoUsd: number; readonly spentNanoUsd: number };
}

export function checkCaps(input: CapInput): CapDecision {
  const runLeft = input.perRunCapNanoUsd - input.runSpentNanoUsd;
  if (input.worstCaseNanoUsd > runLeft) {
    return {
      ok: false,
      cap: "per_run",
      worstCaseNanoUsd: input.worstCaseNanoUsd,
      remainingNanoUsd: Math.max(0, runLeft),
    };
  }
  const dayLeft = input.dailyCapNanoUsd - input.daySpentNanoUsd;
  if (input.worstCaseNanoUsd > dayLeft) {
    return {
      ok: false,
      cap: "daily",
      worstCaseNanoUsd: input.worstCaseNanoUsd,
      remainingNanoUsd: Math.max(0, dayLeft),
    };
  }
  if (input.session) {
    const sessionLeft = input.session.capNanoUsd - input.session.spentNanoUsd;
    if (input.worstCaseNanoUsd > sessionLeft) {
      return {
        ok: false,
        cap: "session",
        worstCaseNanoUsd: input.worstCaseNanoUsd,
        remainingNanoUsd: Math.max(0, sessionLeft),
      };
    }
  }
  return { ok: true };
}

/** Midnight UTC of `now`: the daily cap's window. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * An upper bound on prompt tokens without a network call: the UTF-8 byte length of everything sent
 * (system text, blocks including base64 documents, and the output JSON schema). A token is at least
 * one byte of text, so this over-estimates; for a PDF it counts the base64 bytes, which is far above
 * what a page costs, so the cap errs on the side of refusing.
 */
export function inputTokensUpperBound(
  system: string,
  blocks: readonly ModelBlock[],
  outputSchema: unknown,
): number {
  return (
    Buffer.byteLength(system, "utf8") +
    Buffer.byteLength(JSON.stringify(blocks), "utf8") +
    Buffer.byteLength(JSON.stringify(outputSchema), "utf8")
  );
}
