// The extraction call (M2-02): one document in, verified facts out. The model gets the document as
// data (a PDF or image block, plus the text layer wrapped as untrusted data) and a schema; code then
// checks every quote against the text layer (verify-quotes.ts). At most one call per document; one
// retry only for a typed `max_tokens` or schema failure, which is the harness's second call.
import {
  type ExtractedFact,
  type ExtractionDocType,
  type ExtractionFailureCode,
  extractionTypeOf,
} from "@carnet/domain";
import { type InjectionFlag, scanInjection, wrapUntrusted } from "../guardrail";
import type { CallOutcome, Harness, RunHandle } from "../harness";
import type { ModelId } from "../pricing";
import type { ModelBlock } from "../structured";
import { EXTRACTION_PROMPTS } from "./prompts/index";
import { readTextLayer, type TextLayer, verifyFacts } from "./verify-quotes";

export const EXTRACT_MODEL: ModelId = "claude-haiku-5-5";
export const FIRST_MAX_TOKENS = 3_000;
export const RETRY_MAX_TOKENS = 4_096;

export interface ExtractableDocument {
  readonly kind: string;
  readonly mime: "application/pdf" | "image/jpeg" | "image/png";
  readonly bytes: Uint8Array;
}

export interface ExtractionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costNanoUsd: number;
  readonly calls: number;
}

interface Common {
  readonly docType: ExtractionDocType | null;
  readonly promptVersion: string | null;
  readonly model: string;
  readonly textLayer: boolean;
  readonly injectionFlags: readonly InjectionFlag[];
  readonly usage: ExtractionUsage;
}

export type ExtractionResult =
  | (Common & { readonly status: "EXTRACTED"; readonly facts: readonly ExtractedFact[] })
  | (Common & {
      readonly status: "EXTRACTION_FAILED";
      readonly failure: ExtractionFailureCode;
      readonly detail: string;
    });

const NO_USAGE: ExtractionUsage = { inputTokens: 0, outputTokens: 0, costNanoUsd: 0, calls: 0 };

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** The content blocks: an instruction, the document itself, and the text layer as untrusted data. */
export function buildBlocks(
  type: ExtractionDocType,
  doc: ExtractableDocument,
  layer: TextLayer | null,
): ModelBlock[] {
  const blocks: ModelBlock[] = [
    {
      type: "text",
      text: `Extract the facts of this ${type.replace("_", " ")}. The document is attached${
        layer ? ", followed by its extracted text, page by page" : ""
      }. Quote from the printed text.`,
    },
  ];
  if (doc.mime === "application/pdf") {
    blocks.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: base64(doc.bytes) },
    });
  } else {
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: doc.mime, data: base64(doc.bytes) },
    });
  }
  if (layer) {
    layer.pages.forEach((text, i) => {
      blocks.push({ type: "text", text: wrapUntrusted(`page-${i + 1}-text`, text) });
    });
  }
  return blocks;
}

function failure(
  common: Omit<Common, "usage"> & { usage?: ExtractionUsage },
  code: ExtractionFailureCode,
  detail: string,
): ExtractionResult {
  return {
    ...common,
    usage: common.usage ?? NO_USAGE,
    status: "EXTRACTION_FAILED",
    failure: code,
    detail,
  };
}

function failureOf(outcome: CallOutcome<unknown>): { code: ExtractionFailureCode; detail: string } {
  switch (outcome.outcome) {
    case "disabled":
      return { code: "AGENTS_DISABLED", detail: "model calls are switched off" };
    case "cap_exceeded":
      return { code: "CAP_EXCEEDED", detail: `${outcome.cap} spend cap` };
    case "limit_exceeded":
      return { code: "LIMIT_EXCEEDED", detail: outcome.limit };
    case "refused":
      return { code: "MODEL_REFUSED", detail: "the model declined to read the document" };
    case "truncated":
      return { code: "MODEL_TRUNCATED", detail: "the model's answer was cut off twice" };
    case "provider_error":
      return {
        code: "MODEL_ERROR",
        detail: `${outcome.reason}${outcome.status ? ` ${outcome.status}` : ""}`,
      };
    default:
      return { code: "MODEL_ERROR", detail: outcome.outcome };
  }
}

export interface ExtractParams {
  readonly harness: Harness;
  readonly run: RunHandle;
  /** The harness question key; use a new one for each deliberate re-extraction. */
  readonly step: string;
  readonly document: ExtractableDocument;
  readonly model?: ModelId;
}

/** Runs the extraction. Never throws for a model or provider problem: it returns EXTRACTION_FAILED. */
export async function extractDocument(params: ExtractParams): Promise<ExtractionResult> {
  const { harness, run, step, document } = params;
  const model = params.model ?? EXTRACT_MODEL;
  const type = extractionTypeOf(document.kind);
  if (!type) {
    return failure(
      { docType: null, promptVersion: null, model, textLayer: false, injectionFlags: [] },
      "UNSUPPORTED_KIND",
      `no extraction schema for kind ${document.kind}`,
    );
  }
  const prompt = EXTRACTION_PROMPTS[type];
  const layer = document.mime === "application/pdf" ? await readTextLayer(document.bytes) : null;
  const injectionFlags = layer ? scanInjection(layer.pages.join("\n")) : [];
  const common = {
    docType: type,
    promptVersion: prompt.VERSION,
    model,
    textLayer: layer !== null,
    injectionFlags,
  };
  const blocks = buildBlocks(type, document, layer);

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

  let outcome = await call(FIRST_MAX_TOKENS);
  const retryable =
    outcome.outcome === "truncated" ||
    (outcome.outcome === "provider_error" && outcome.reason === "invalid_output");
  if (retryable) outcome = await call(RETRY_MAX_TOKENS);

  if (outcome.outcome !== "ok" && outcome.outcome !== "replayed") {
    const f = failureOf(outcome);
    return failure({ ...common, usage }, f.code, f.detail);
  }
  const facts = verifyFacts(type, outcome.output.facts, layer);
  return { ...common, usage, status: "EXTRACTED", facts };
}
