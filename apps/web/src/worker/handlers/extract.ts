// `document.extract` (M2-02, ADR 0005, 0010): reads the stored document, runs the extraction through the
// agent harness and writes the facts version plus the `document.extracted` event in one transaction.
// Idempotent: a retry or a re-delivery replays the model's stored output (no second call) and the facts
// write is keyed by the job id, so one job stores at most one version.
import {
  createHarness,
  type ExtractionStore,
  isModelId,
  runExtraction,
  type Transport,
} from "@carnet/agent";
import {
  agentHarnessStore,
  getDocumentContent,
  insertFactsVersion,
  repoCtx,
  withTransaction,
} from "@carnet/db";
import type { BusinessId, DocumentId } from "@carnet/domain";
import { DOCUMENT_JOB_KIND, publishDocumentExtracted } from "../../server/documents/jobs";
import { type HandlerContext, type JobHandler, payloadString } from "./index";

export function extractionStoreFor(
  ctx: Pick<HandlerContext, "db">,
  businessId: BusinessId,
): ExtractionStore {
  const repo = repoCtx(ctx.db, businessId);
  return {
    async loadDocument(documentId) {
      const content = await getDocumentContent(repo, documentId as DocumentId);
      return content
        ? { kind: content.document.kind, mime: content.document.mime, bytes: content.bytes }
        : null;
    },
    async saveExtraction({ documentId, extractionKey, runId, result }) {
      return withTransaction(ctx.db, async (tx) => {
        const txRepo = repoCtx(tx, businessId);
        const stored = await insertFactsVersion(txRepo, {
          documentId: documentId as DocumentId,
          source: "model",
          status: result.status,
          failure: result.status === "EXTRACTION_FAILED" ? result.failure : null,
          extractionKey,
          promptVersion: result.promptVersion,
          model: result.model,
          textLayer: result.textLayer,
          facts: result.status === "EXTRACTED" ? result.facts : [],
          injectionFlags: result.injectionFlags,
          agentRunId: runId,
        });
        if (stored.inserted) {
          await publishDocumentExtracted(tx, {
            businessId,
            documentId,
            version: stored.version.version,
            source: "model",
            status: result.status,
          });
        }
        return { version: stored.version.version, inserted: stored.inserted };
      });
    },
  };
}

export interface ExtractHandlerOptions {
  /** HTTP transport for the model client (tests replay recorded responses); default: global fetch. */
  readonly transport?: Transport;
}

export function createDocumentExtractHandler(options: ExtractHandlerOptions = {}): JobHandler {
  return async (payload, ctx, job) => {
    const businessId = payloadString(payload, "businessId") as BusinessId;
    const documentId = payloadString(payload, "documentId");
    const harness = createHarness({
      store: agentHarnessStore(repoCtx(ctx.db, businessId)),
      ...(options.transport ? { transport: options.transport } : {}),
    });
    const configured = process.env.ANTHROPIC_MODEL_EXTRACT;
    const model = configured && isModelId(configured) ? configured : undefined;
    const out = await runExtraction({
      harness,
      store: extractionStoreFor(ctx, businessId),
      documentId,
      extractionKey: job.id,
      ...(model ? { model } : {}),
    });
    ctx.logger.info({ businessId, documentId, ...out }, "document extracted");
  };
}

export const handleDocumentExtract: JobHandler = createDocumentExtractHandler();

/** Acknowledges `document.extracted` until M2-03 and M2-05 register their consumers. */
export const handleDocumentExtracted: JobHandler = async (payload, ctx) => {
  ctx.logger.info({ event: DOCUMENT_JOB_KIND.extracted, payload }, "document facts stored");
};
