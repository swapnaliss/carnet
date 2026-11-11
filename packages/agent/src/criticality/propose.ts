// The criticality proposal (M3-01): one contract in, one proposal out. The model reads the contract's
// text layer as untrusted data and proposes a value with a quote; code checks the quote (verbatim on the
// cited page, and about late-payment consequences) and decides `VERIFIED` or `REJECTED`. The proposal
// never sets a criticality: a person confirms it through the API (ADR 0011). At most one call per
// proposal; one retry only for a typed `max_tokens` or schema failure (the harness's second call).
import {
  type CriticalityRejectReason,
  type CriticalityValue,
  isCriticalityValue,
  verifyCriticalityQuote,
} from "@carnet/domain";
import { readTextLayer } from "../extraction/verify-quotes";
import { type InjectionFlag, scanInjection, wrapUntrusted } from "../guardrail";
import type { Harness, RunHandle } from "../harness";
import type { ModelId } from "../pricing";
import type { ModelBlock } from "../structured";
import * as prompt from "./prompts/criticality";

export const CRITICALITY_MODEL: ModelId = "claude-sonnet-5-5";
export const CRITICALITY_RUN_KIND = "criticality_proposal";
export const CRITICALITY_FIRST_MAX_TOKENS = 1_200;
export const CRITICALITY_RETRY_MAX_TOKENS = 2_400;
export const CRITICALITY_PROMPT_VERSION = prompt.VERSION;
export const CRITICALITY_SYSTEM = prompt.SYSTEM;
export const CriticalityOutputSchema = prompt.Schema;

export interface ContractDocument {
  readonly mime: string;
  readonly bytes: Uint8Array;
}

export interface CriticalityUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanoUsd: number;
  readonly calls: number;
}

interface Common {
  readonly promptVersion: string;
  readonly model: string;
  readonly injectionSuspected: boolean;
  readonly injectionFlags: readonly InjectionFlag[];
  readonly usage: CriticalityUsage;
  /** What the model said, kept for review even when the verifier rejects it. */
  readonly rationale: string;
  readonly quote: string;
  readonly page: number;
}

export type CriticalityResult =
  | (Common & { readonly verifierResult: "VERIFIED"; readonly proposed: CriticalityValue })
  | (Common & {
      readonly verifierResult: "REJECTED";
      readonly reason: CriticalityRejectReason;
      /** Why the call produced nothing, for the log (a cap, a refusal, a provider error). */
      readonly detail: string;
    });

const NO_USAGE: CriticalityUsage = { inputTokens: 0, outputTokens: 0, costNanoUsd: 0, calls: 0 };

/** The content blocks: one instruction, then each page of the contract as untrusted data. */
export function buildCriticalityBlocks(pages: readonly string[]): ModelBlock[] {
  return [
    {
      type: "text",
      text: "Propose the criticality of paying an invoice late under this contract. The contract text follows, page by page.",
    },
    ...pages.map(
      (text, i): ModelBlock => ({
        type: "text",
        text: wrapUntrusted(`page-${i + 1}-text`, text),
      }),
    ),
  ];
}

export interface ProposeParams {
  readonly harness: Harness;
  readonly run: RunHandle;
  /** The harness question key; use a new one for each deliberate re-proposal. */
  readonly step: string;
  readonly document: ContractDocument;
  readonly model?: ModelId;
}

/** Never throws for a model or provider problem: it returns a REJECTED result with the reason. */
export async function proposeCriticality(params: ProposeParams): Promise<CriticalityResult> {
  const { harness, run, step, document } = params;
  const model = params.model ?? CRITICALITY_MODEL;
  const layer = document.mime === "application/pdf" ? await readTextLayer(document.bytes) : null;
  const base = {
    promptVersion: prompt.VERSION,
    model,
    rationale: "",
    quote: "",
    page: 0,
  };
  // An image-only contract has no text layer to verify a quote against: no model call, no proposal.
  if (!layer) {
    return {
      ...base,
      verifierResult: "REJECTED",
      reason: "no_text_layer",
      detail: "no text layer",
      injectionSuspected: false,
      injectionFlags: [],
      usage: NO_USAGE,
    };
  }
  const scanFlags = scanInjection(layer.pages.join("\n"));
  const blocks = buildCriticalityBlocks(layer.pages);

  let usage = NO_USAGE;
  const call = async (maxTokens: number) => {
    const outcome = await harness.callStructured({
      run,
      step,
      promptVersion: prompt.VERSION,
      model,
      system: prompt.SYSTEM,
      blocks,
      schema: prompt.Schema,
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

  let outcome = await call(CRITICALITY_FIRST_MAX_TOKENS);
  const retryable =
    outcome.outcome === "truncated" ||
    (outcome.outcome === "provider_error" && outcome.reason === "invalid_output");
  if (retryable) outcome = await call(CRITICALITY_RETRY_MAX_TOKENS);

  if (outcome.outcome !== "ok" && outcome.outcome !== "replayed") {
    return {
      ...base,
      verifierResult: "REJECTED",
      reason: "model_unavailable",
      detail: outcome.outcome,
      injectionSuspected: scanFlags.length > 0,
      injectionFlags: scanFlags,
      usage,
    };
  }

  const out = outcome.output;
  const common: Common = {
    ...base,
    rationale: out.rationale,
    quote: out.quote,
    page: out.page,
    injectionSuspected: out.injection_suspected || scanFlags.length > 0,
    injectionFlags: scanFlags,
    usage,
  };
  const value = out.criticality === "NONE" ? null : Number(out.criticality);
  if (value === null || !isCriticalityValue(value)) {
    return {
      ...common,
      verifierResult: "REJECTED",
      reason: "no_clause",
      detail: "model found none",
    };
  }
  const verdict = verifyCriticalityQuote(out.quote, out.page, layer.pages);
  if (!verdict.ok) {
    return {
      ...common,
      verifierResult: "REJECTED",
      reason: verdict.reason,
      detail: verdict.reason,
    };
  }
  return { ...common, verifierResult: "VERIFIED", proposed: value };
}
