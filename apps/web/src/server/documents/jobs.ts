// Outbox jobs for document extraction (M2-02, ADR 0005).
//   document.extract    queued when a new document of an extractable kind is stored; the worker runs it
//   document.extracted  published in the same transaction as a stored facts version (model or owner);
//                       M2-03 (evidence rules) and M2-05 (drafting) consume it

import type { Db } from "@carnet/db";
import { schema } from "@carnet/db";

export const DOCUMENT_JOB_KIND = {
  extract: "document.extract",
  extracted: "document.extracted",
} as const;

/** A database handle or an open transaction. */
type Tx = Pick<Db, "insert">;

export async function enqueueDocumentExtraction(
  tx: Tx,
  input: { businessId: string; documentId: string; sessionId?: string },
): Promise<void> {
  await tx.insert(schema.outboxJobs).values({ kind: DOCUMENT_JOB_KIND.extract, payload: input });
}

export interface DocumentExtractedEvent {
  readonly businessId: string;
  readonly documentId: string;
  readonly version: number;
  readonly source: "model" | "owner";
  readonly status: "EXTRACTED" | "EXTRACTION_FAILED";
}

export async function publishDocumentExtracted(
  tx: Tx,
  event: DocumentExtractedEvent,
): Promise<void> {
  await tx.insert(schema.outboxJobs).values({ kind: DOCUMENT_JOB_KIND.extracted, payload: event });
}
