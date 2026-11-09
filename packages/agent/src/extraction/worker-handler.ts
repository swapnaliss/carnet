// The `document.extract` job body (M2-02, ADR 0005). packages/agent may import only the domain, so the
// document and the facts live behind a port that apps/web implements over the repositories. The job is
// idempotent: a retry after a crash finds the model's stored output in the harness (no second call) and
// the facts write is keyed by the extraction key, so it inserts at most one version.
import type { Harness } from "../harness";
import type { ModelId } from "../pricing";
import { type ExtractableDocument, type ExtractionResult, extractDocument } from "./extract";

export interface ExtractionStore {
  /** The document's kind, mime and bytes, or null when this business has no such document. */
  loadDocument(documentId: string): Promise<ExtractableDocument | null>;
  /**
   * Inserts the next fact version for the document and publishes `document.extracted` in the same
   * transaction. `extractionKey` makes the write idempotent: a second call with the same key inserts
   * nothing and returns the existing version.
   */
  saveExtraction(input: {
    documentId: string;
    extractionKey: string;
    runId: string;
    result: ExtractionResult;
  }): Promise<{ version: number; inserted: boolean }>;
}

export interface RunExtractionParams {
  readonly harness: Harness;
  readonly store: ExtractionStore;
  readonly documentId: string;
  /** The job id for the first extraction; a new value for a deliberate re-extraction. */
  readonly extractionKey: string;
  readonly model?: ModelId;
}

export interface RunExtractionResult {
  readonly status: ExtractionResult["status"];
  readonly version: number;
  readonly inserted: boolean;
}

export const EXTRACTION_RUN_KIND = "extraction";

/** Step name for the harness question: one question per (document, extraction key). */
export const extractionStep = (extractionKey: string) => `extract:${extractionKey}`;

export async function runExtraction(params: RunExtractionParams): Promise<RunExtractionResult> {
  const { harness, store, documentId, extractionKey } = params;
  const document = await store.loadDocument(documentId);
  if (!document) throw new Error(`document ${documentId} not found`);

  const run = await harness.startRun({ kind: EXTRACTION_RUN_KIND, ref: documentId });
  let result: ExtractionResult;
  try {
    result = await extractDocument({
      harness,
      run,
      step: extractionStep(extractionKey),
      document,
      ...(params.model ? { model: params.model } : {}),
    });
  } catch (error) {
    await harness.finishRun(run, "FAILED");
    throw error;
  }
  await harness.finishRun(run, result.status === "EXTRACTED" ? "DONE" : "FAILED");
  const saved = await store.saveExtraction({ documentId, extractionKey, runId: run.id, result });
  return { status: result.status, ...saved };
}
