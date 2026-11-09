// Document facts repository (M2-02, ADR 0010). Versions are immutable: `insertFactsVersion` is the only
// writer, there is no update or delete function, the app role has no UPDATE or DELETE on the table, and
// a trigger refuses both for every role (migration 0010). A re-extraction, an owner correction and an
// owner confirmation each insert version n+1.
//
// Call `insertFactsVersion` inside the transaction that also enqueues `document.extracted` (ADR 0005).
// Tenant repository: `ctx` first, every statement scoped by `ctx.businessId`.
import {
  type DocumentId,
  type ExtractedFact,
  ExtractedFactSchema,
  type UsableFacts,
  usableFacts,
} from "@carnet/domain";
import { and, desc, eq, sql } from "drizzle-orm";
import { FactsVersionConflictError, translateDbError, UniqueViolationError } from "../errors";
import { documentFacts } from "../schema/index";
import type { RepoCtx } from "./context";

export interface StoredFactsVersion {
  readonly id: string;
  readonly documentId: DocumentId;
  readonly version: number;
  readonly extractionKey: string | null;
  readonly source: "model" | "owner";
  readonly status: "EXTRACTED" | "EXTRACTION_FAILED";
  readonly failure: string | null;
  readonly promptVersion: string | null;
  readonly model: string | null;
  readonly textLayer: boolean;
  readonly facts: readonly ExtractedFact[];
  readonly quotes: readonly { key: string; text: string; page: number }[];
  readonly quotesVerified: boolean;
  readonly ownerConfirmedBy: string | null;
  readonly injectionFlags: readonly { kind: string; rule: string; match: string }[];
  readonly agentRunId: string | null;
  readonly createdAt: Date;
}

export interface NewFactsVersion {
  readonly documentId: DocumentId;
  readonly source: "model" | "owner";
  readonly status: "EXTRACTED" | "EXTRACTION_FAILED";
  /** Required iff `status` is EXTRACTION_FAILED. */
  readonly failure?: string | null;
  /** Makes the insert idempotent per document (the job id for a model extraction). */
  readonly extractionKey?: string | null;
  readonly promptVersion?: string | null;
  readonly model?: string | null;
  readonly textLayer: boolean;
  readonly facts: readonly ExtractedFact[];
  readonly injectionFlags?: readonly { kind: string; rule: string; match: string }[];
  /** Required iff `source` is `owner`. */
  readonly ownerConfirmedBy?: string | null;
  readonly agentRunId?: string | null;
}

type Row = typeof documentFacts.$inferSelect;

function toStored(row: Row): StoredFactsVersion {
  return {
    id: row.id,
    documentId: row.documentId as DocumentId,
    version: row.version,
    extractionKey: row.extractionKey,
    source: row.source as StoredFactsVersion["source"], // CHECK document_facts_source_check
    status: row.status as StoredFactsVersion["status"], // CHECK document_facts_status_check
    failure: row.failure,
    promptVersion: row.promptVersion,
    model: row.model,
    textLayer: row.textLayer,
    facts: row.facts.map((f) => ExtractedFactSchema.parse(f)),
    quotes: row.quotes as StoredFactsVersion["quotes"],
    quotesVerified: row.quotesVerified,
    ownerConfirmedBy: row.ownerConfirmedBy,
    injectionFlags: row.injectionFlags as StoredFactsVersion["injectionFlags"],
    agentRunId: row.agentRunId,
    createdAt: row.createdAt,
  };
}

const MAX_ATTEMPTS = 5;

export async function insertFactsVersion(
  ctx: RepoCtx,
  input: NewFactsVersion,
): Promise<{ version: StoredFactsVersion; inserted: boolean }> {
  const key = input.extractionKey ?? null;
  const quotes = input.facts
    .filter((f) => f.quote.length > 0)
    .map((f) => ({ key: f.key, text: f.quote, page: f.page }));
  const quotesVerified = input.facts.length > 0 && input.facts.every((f) => f.quote_verified);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (key !== null) {
      const existing = await getFactsByKey(ctx, input.documentId, key);
      if (existing) return { version: existing, inserted: false };
    }
    try {
      const [row] = await ctx.db
        .insert(documentFacts)
        .values({
          businessId: ctx.businessId,
          documentId: input.documentId,
          version: sql<number>`(SELECT coalesce(max(${documentFacts.version}), 0) + 1 FROM ${documentFacts} WHERE ${documentFacts.businessId} = ${ctx.businessId} AND ${documentFacts.documentId} = ${input.documentId})`,
          extractionKey: key,
          source: input.source,
          status: input.status,
          failure: input.failure ?? null,
          promptVersion: input.promptVersion ?? null,
          model: input.model ?? null,
          textLayer: input.textLayer,
          facts: [...input.facts],
          quotes,
          quotesVerified,
          ownerConfirmedBy: input.ownerConfirmedBy ?? null,
          injectionFlags: [...(input.injectionFlags ?? [])],
          agentRunId: input.agentRunId ?? null,
        })
        .returning();
      if (!row) throw new Error("document_facts insert returned no row");
      return { version: toStored(row), inserted: true };
    } catch (error) {
      const translated = translateDbError(error);
      // A concurrent writer took the version number: take the next one. A concurrent writer with
      // the same extraction key: the loop's lookup returns its row.
      if (
        translated instanceof UniqueViolationError &&
        (translated.constraint === "document_facts_document_version_key" ||
          translated.constraint === "document_facts_extraction_key_key")
      ) {
        continue;
      }
      throw translated;
    }
  }
  throw new FactsVersionConflictError(input.documentId);
}

async function getFactsByKey(
  ctx: RepoCtx,
  documentId: DocumentId,
  extractionKey: string,
): Promise<StoredFactsVersion | null> {
  const [row] = await ctx.db
    .select()
    .from(documentFacts)
    .where(
      and(
        eq(documentFacts.businessId, ctx.businessId),
        eq(documentFacts.documentId, documentId),
        eq(documentFacts.extractionKey, extractionKey),
      ),
    );
  return row ? toStored(row) : null;
}

export async function getFactsVersion(
  ctx: RepoCtx,
  documentId: DocumentId,
  version: number,
): Promise<StoredFactsVersion | null> {
  const [row] = await ctx.db
    .select()
    .from(documentFacts)
    .where(
      and(
        eq(documentFacts.businessId, ctx.businessId),
        eq(documentFacts.documentId, documentId),
        eq(documentFacts.version, version),
      ),
    );
  return row ? toStored(row) : null;
}

export async function getLatestFacts(
  ctx: RepoCtx,
  documentId: DocumentId,
): Promise<StoredFactsVersion | null> {
  const [row] = await ctx.db
    .select()
    .from(documentFacts)
    .where(
      and(eq(documentFacts.businessId, ctx.businessId), eq(documentFacts.documentId, documentId)),
    )
    .orderBy(desc(documentFacts.version))
    .limit(1);
  return row ? toStored(row) : null;
}

/** Every version of the document's facts, newest first. */
export async function listFactVersions(
  ctx: RepoCtx,
  documentId: DocumentId,
): Promise<StoredFactsVersion[]> {
  const rows = await ctx.db
    .select()
    .from(documentFacts)
    .where(
      and(eq(documentFacts.businessId, ctx.businessId), eq(documentFacts.documentId, documentId)),
    )
    .orderBy(desc(documentFacts.version));
  return rows.map(toStored);
}

/**
 * The only function evidence rules (M2-03) and drafting (M2-05) read facts through. It looks at the
 * LATEST version and returns a fact only when it is usable as evidence: verified against the document
 * (quote on the page, value derivable from it), or part of a version an owner confirmed. Image-only
 * facts, unverified facts, unparseable values and failed extractions are never returned. Null when the
 * document has no version.
 */
export async function getUsableFacts(
  ctx: RepoCtx,
  documentId: DocumentId,
): Promise<UsableFacts | null> {
  const latest = await getLatestFacts(ctx, documentId);
  if (!latest) return null;
  return {
    document_id: latest.documentId,
    version: latest.version,
    confirmed: latest.ownerConfirmedBy !== null,
    facts: usableFacts(latest),
  };
}
