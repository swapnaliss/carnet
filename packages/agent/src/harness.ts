// The agent harness: the one way Carnet calls a model (ADR 0009, architecture §10). Every call goes
// through `callStructured`, which in order:
//   1. rejects a request over the per-call token limit             -> limit_exceeded (max_tokens)
//   2. reads the kill switch fresh                                  -> disabled (AGENTS_DISABLED)
//   3. replays a stored output for the same inputs                  -> replayed (no network, no cost)
//   4. enforces 2 calls per question and the run's wall clock       -> limit_exceeded
//   5. prices the worst case against the per-run and daily caps     -> cap_exceeded (nothing written)
//   6. sends one structured call with a per-call wall-clock limit   -> ok | refused | truncated |
//                                                                     limit_exceeded | provider_error
// and records one step per network call (tokens, cost, stop_reason, prompt version, input hash).
// The model gets no tools and no credentials; documents are data (guardrail.ts).
import type { z } from "zod";
import { type CapName, checkCaps, inputTokensUpperBound, utcDayStart } from "./caps";
import type { Transport } from "./client";
import { composeSystem } from "./guardrail";
import { costNanoUsd, type ModelId, type TokenUsage, worstCaseCostNanoUsd } from "./pricing";
import { jsonSchemaOf, promptVersion as versionOf } from "./prompt-version";
import { inputHash as hashInput, lookupReplay } from "./replay";
import type { HarnessStore, StepOutcome } from "./store";
import { type ModelBlock, type SendResult, sendStructured } from "./structured";

export interface HarnessLimits {
  /** Model calls per question (run kind + ref + step), across runs. */
  readonly maxCallsPerQuestion: number;
  /** Largest `max_tokens` a call may request. */
  readonly maxTokensPerCall: number;
  /** Wall clock for one call, retries included. */
  readonly callTimeLimitMs: number;
  /** Wall clock for one run, from `startRun`. */
  readonly runTimeLimitMs: number;
}

export const DEFAULT_LIMITS: HarnessLimits = {
  maxCallsPerQuestion: 2,
  maxTokensPerCall: 4_096,
  callTimeLimitMs: 90_000,
  runTimeLimitMs: 15 * 60_000,
};

export interface RunHandle {
  readonly id: string;
  readonly kind: string;
  readonly ref: string;
}

export interface StructuredRequest<S extends z.ZodType> {
  readonly run: RunHandle;
  /** The question key: at most `maxCallsPerQuestion` calls per (run kind, ref, step). */
  readonly step: string;
  /** `promptVersion(system, schema)` from the prompt module; checked against the inputs. */
  readonly promptVersion: string;
  readonly model: ModelId;
  /** The prompt's own system text; the harness appends the untrusted-data rule. */
  readonly system: string;
  readonly blocks: readonly ModelBlock[];
  readonly schema: S;
  /** Defaults to the per-call limit. */
  readonly maxTokens?: number;
}

export type LimitName = "calls_per_question" | "max_tokens" | "call_time" | "run_time";

export type ProviderErrorReason =
  | "invalid_output"
  | "unexpected_stop_reason"
  | "http"
  | "timeout"
  | "network"
  | "missing_credential";

interface StepInfo {
  readonly stepId: string;
  readonly promptVersion: string;
  readonly inputHash: string;
}

interface Billing {
  readonly stopReason: string | null;
  readonly usage: TokenUsage;
  readonly costNanoUsd: number;
  readonly latencyMs: number;
}

/** Every outcome of a call. Callers map anything but `ok` and `replayed` to their own degradation. */
export type CallOutcome<T> =
  | ({ readonly outcome: "ok"; readonly replayed: false; readonly output: T } & StepInfo & Billing)
  | ({ readonly outcome: "replayed"; readonly replayed: true; readonly output: T } & StepInfo)
  | ({ readonly outcome: "refused"; readonly replayed: false } & StepInfo & Billing)
  | ({ readonly outcome: "truncated"; readonly replayed: false } & StepInfo & Billing)
  | { readonly outcome: "disabled"; readonly replayed: false; readonly code: "AGENTS_DISABLED" }
  | {
      readonly outcome: "cap_exceeded";
      readonly replayed: false;
      readonly code: "CAP_EXCEEDED";
      readonly cap: CapName;
      readonly worstCaseNanoUsd: number;
      readonly remainingNanoUsd: number;
    }
  | {
      readonly outcome: "limit_exceeded";
      readonly replayed: false;
      readonly code: "LIMIT_EXCEEDED";
      readonly limit: LimitName;
      /** Set when a call was sent (call_time): the step that recorded it. */
      readonly stepId?: string;
    }
  | {
      readonly outcome: "provider_error";
      readonly replayed: false;
      readonly reason: ProviderErrorReason;
      readonly status: number | null;
      readonly message: string;
      /** Set when the call reached the provider. */
      readonly stepId?: string;
    };

export type CallOutcomeKind = CallOutcome<unknown>["outcome"];

export interface HarnessDeps {
  readonly store: HarnessStore;
  /** HTTP transport for the SDK (default: global fetch). */
  readonly transport?: Transport;
  readonly limits?: Partial<HarnessLimits>;
  readonly now?: () => Date;
  /** SDK retries (default 2). */
  readonly maxRetries?: number;
}

export interface Harness {
  readonly limits: HarnessLimits;
  startRun(input: { kind: string; ref: string }): Promise<RunHandle>;
  finishRun(run: RunHandle, status: "DONE" | "FAILED"): Promise<void>;
  callStructured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<CallOutcome<z.infer<S>>>;
}

export class PromptVersionMismatchError extends Error {
  constructor(step: string) {
    super(`promptVersion for step "${step}" does not match its system text and schema`);
    this.name = "PromptVersionMismatchError";
  }
}

const limitExceeded = (limit: LimitName, stepId?: string) =>
  ({
    outcome: "limit_exceeded",
    replayed: false,
    code: "LIMIT_EXCEEDED",
    limit,
    ...(stepId ? { stepId } : {}),
  }) as const;

function stepOutcomeOf(result: SendResult<unknown>): StepOutcome {
  switch (result.kind) {
    case "ok":
      return "ok";
    case "refused":
      return "refused";
    case "truncated":
      return "truncated";
    default:
      return "provider_error";
  }
}

export function createHarness(deps: HarnessDeps): Harness {
  const limits: HarnessLimits = { ...DEFAULT_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => new Date());
  const transport: Transport = deps.transport ?? ((input, init) => fetch(input, init));
  const { store } = deps;

  async function callStructured<S extends z.ZodType>(
    req: StructuredRequest<S>,
  ): Promise<CallOutcome<z.infer<S>>> {
    const maxTokens = req.maxTokens ?? limits.maxTokensPerCall;
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > limits.maxTokensPerCall) {
      return limitExceeded("max_tokens");
    }
    if (versionOf(req.system, req.schema) !== req.promptVersion) {
      throw new PromptVersionMismatchError(req.step);
    }

    // Kill switch: read fresh before every call; an unreadable flag row means disabled.
    const flags = await store.readFlags().catch(() => null);
    if (!flags?.agentsEnabled) {
      return { outcome: "disabled", replayed: false, code: "AGENTS_DISABLED" };
    }

    const inputHash = hashInput(req.model, req.blocks);
    const key = { kind: req.run.kind, ref: req.run.ref, step: req.step };
    const hit = await lookupReplay(
      store,
      { ...key, inputHash, promptVersion: req.promptVersion },
      req.schema,
    );
    if (hit) {
      return {
        outcome: "replayed",
        replayed: true,
        output: hit.output,
        stepId: hit.stepId,
        promptVersion: req.promptVersion,
        inputHash,
      };
    }

    if ((await store.countCalls(key)) >= limits.maxCallsPerQuestion) {
      return limitExceeded("calls_per_question");
    }
    const run = await store.getRun(req.run.id);
    if (!run) throw new Error(`run ${req.run.id} not found`);
    const startedAt = now();
    if (startedAt.getTime() - run.startedAt.getTime() > limits.runTimeLimitMs) {
      return limitExceeded("run_time");
    }

    const system = composeSystem(req.system);
    const worstCase = worstCaseCostNanoUsd(
      req.model,
      inputTokensUpperBound(system, req.blocks, jsonSchemaOf(req.schema)),
      maxTokens,
    );
    const caps = checkCaps({
      perRunCapNanoUsd: flags.perRunCapNanoUsd,
      dailyCapNanoUsd: flags.dailyCapNanoUsd,
      runSpentNanoUsd: run.costNanoUsd,
      daySpentNanoUsd: await store.spentSinceNanoUsd(utcDayStart(startedAt)),
      worstCaseNanoUsd: worstCase,
    });
    if (!caps.ok) {
      return {
        outcome: "cap_exceeded",
        replayed: false,
        code: "CAP_EXCEEDED",
        cap: caps.cap,
        worstCaseNanoUsd: caps.worstCaseNanoUsd,
        remainingNanoUsd: caps.remainingNanoUsd,
      };
    }

    // Per-call wall clock (retries included). Never longer than what is left of the run.
    const runLeftMs = limits.runTimeLimitMs - (startedAt.getTime() - run.startedAt.getTime());
    const signal = AbortSignal.timeout(Math.max(1, Math.min(limits.callTimeLimitMs, runLeftMs)));
    const t0 = performance.now();
    let result: SendResult<z.infer<S>>;
    try {
      result = await sendStructured({
        model: req.model,
        system,
        blocks: req.blocks,
        schema: req.schema,
        maxTokens,
        signal,
        transport,
        ...(deps.maxRetries === undefined ? {} : { maxRetries: deps.maxRetries }),
      });
    } catch (error) {
      // createModelClient throws before any request when the key is missing.
      return {
        outcome: "provider_error",
        replayed: false,
        reason: "missing_credential",
        status: null,
        message: error instanceof Error ? error.message : "model client unavailable",
      };
    }
    const latencyMs = Math.round(performance.now() - t0);

    const billed =
      "usage" in result
        ? {
            stopReason: result.stopReason,
            usage: result.usage,
            costNanoUsd: costNanoUsd(req.model, result.usage),
            requestId: result.requestId,
          }
        : {
            stopReason: null,
            usage: { inputTokens: 0, outputTokens: 0 },
            costNanoUsd: 0,
            requestId: null,
          };
    const stepId = await store.recordStep({
      runId: req.run.id,
      step: req.step,
      promptVersion: req.promptVersion,
      model: req.model,
      inputHash,
      outcome: stepOutcomeOf(result),
      output: result.kind === "ok" ? result.output : null,
      stopReason: billed.stopReason,
      inputTokens: billed.usage.inputTokens,
      outputTokens: billed.usage.outputTokens,
      costNanoUsd: billed.costNanoUsd,
      latencyMs,
      providerRequestId: billed.requestId,
    });

    const info = { stepId, promptVersion: req.promptVersion, inputHash };
    const billing = {
      stopReason: billed.stopReason,
      usage: billed.usage,
      costNanoUsd: billed.costNanoUsd,
      latencyMs,
    };
    switch (result.kind) {
      case "ok":
        return { outcome: "ok", replayed: false, output: result.output, ...info, ...billing };
      case "refused":
        return { outcome: "refused", replayed: false, ...info, ...billing };
      case "truncated":
        return { outcome: "truncated", replayed: false, ...info, ...billing };
      case "aborted":
        return limitExceeded("call_time", stepId);
      case "invalid_output":
        return providerError("invalid_output", null, result.message, stepId);
      case "unexpected_stop_reason":
        return providerError(
          "unexpected_stop_reason",
          null,
          `stop_reason ${String(result.stopReason)}`,
          stepId,
        );
      case "http_error":
        return providerError("http", result.status, result.message, stepId);
      case "timeout":
        return providerError("timeout", null, result.message, stepId);
      case "network_error":
        return providerError("network", null, result.message, stepId);
    }
  }

  return {
    limits,
    async startRun(input) {
      const run = await store.createRun(input);
      return { id: run.id, kind: run.kind, ref: run.ref };
    },
    async finishRun(run, status) {
      await store.finishRun(run.id, status);
    },
    callStructured,
  };
}

function providerError(
  reason: ProviderErrorReason,
  status: number | null,
  message: string,
  stepId: string,
) {
  return { outcome: "provider_error", replayed: false, reason, status, message, stepId } as const;
}
