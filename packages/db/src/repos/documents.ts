// Documents repository (M2-01, ADR 0003). Bytes and their SHA-256 are immutable: there is no update
// function here, the app role cannot UPDATE those columns, and a trigger refuses the change for every
// role (migration 0004). The hash is computed here from the bytes, and the table's CHECK recomputes
// it in the database, so a stored hash always describes the stored bytes.
//
// M2-02 reads bytes and kind with `getDocumentContent`; M2-07 re-hashes the bytes with
// `sha256Hex(content.bytes)` and compares with the approved hash.
import { createHash } from "node:crypto";
import {
  type BusinessId,
  type DocumentId,
  type DocumentKind,
  type DocumentMime,
  newDocumentId,
} from "@carnet/domain";
import { and, desc, eq } from "drizzle-orm";
import { translateDbError } from "../errors";
import { documents } from "../schema/index";
import type { RepoCtx } from "./context";

/** A stored document without its bytes. */
export interface DocumentRecord {
  readonly id: DocumentId;
  readonly businessId: BusinessId;
  readonly kind: DocumentKind;
  readonly filename: string;
  readonly mime: DocumentMime;
  readonly size: number;
  /** Lower-case hex SHA-256 of the bytes. */
  readonly sha256: string;
  readonly createdAt: Date;
}

export interface DocumentContent {
  readonly document: DocumentRecord;
  readonly bytes: Uint8Array;
}

export interface NewDocument {
  kind: DocumentKind;
  /** Already sanitised (domain `sanitizeFilename`), at most 50 characters. */
  filename: string;
  /** Derived from the bytes (domain `inspectDocumentBytes`), never from the client. */
  mime: DocumentMime;
  bytes: Uint8Array;
}

export interface StoreDocumentResult {
  readonly document: DocumentRecord;
  /** True when this business already had these exact bytes; nothing new was written. */
  readonly deduplicated: boolean;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const META = {
  id: documents.id,
  businessId: documents.businessId,
  kind: documents.kind,
  filename: documents.filename,
  mime: documents.mime,
  size: documents.size,
  sha256: documents.sha256,
  createdAt: documents.createdAt,
} as const;

type MetaRow = {
  id: string;
  businessId: string;
  kind: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  createdAt: Date;
};

const toRecord = (r: MetaRow): DocumentRecord => ({
  id: r.id as DocumentId,
  businessId: r.businessId as BusinessId,
  kind: r.kind as DocumentKind, // CHECK documents_kind_check
  filename: r.filename,
  mime: r.mime as DocumentMime, // CHECK documents_mime_check
  size: r.size,
  sha256: r.sha256,
  createdAt: r.createdAt,
});

/**
 * Stores the bytes for this business, or returns the existing document when the business already
 * holds identical bytes (`deduplicated: true`; the existing kind and filename are kept).
 */
export async function storeDocument(
  ctx: RepoCtx,
  input: NewDocument,
): Promise<StoreDocumentResult> {
  const sha256 = sha256Hex(input.bytes);
  try {
    const [row] = await ctx.db
      .insert(documents)
      .values({
        id: newDocumentId(),
        businessId: ctx.businessId,
        kind: input.kind,
        filename: input.filename,
        mime: input.mime,
        size: input.bytes.byteLength,
        sha256,
        bytes: input.bytes,
      })
      .onConflictDoNothing({ target: [documents.businessId, documents.sha256] })
      .returning(META);
    if (row) return { document: toRecord(row), deduplicated: false };
  } catch (error) {
    throw translateDbError(error);
  }
  const existing = await findDocumentBySha256(ctx, sha256);
  if (!existing) throw new Error("document conflict without an existing row");
  return { document: existing, deduplicated: true };
}

export async function getDocument(ctx: RepoCtx, id: DocumentId): Promise<DocumentRecord | null> {
  const [row] = await ctx.db
    .select(META)
    .from(documents)
    .where(and(eq(documents.businessId, ctx.businessId), eq(documents.id, id)));
  return row ? toRecord(row) : null;
}

/** The document and its bytes, or null when this business has no such document. */
export async function getDocumentContent(
  ctx: RepoCtx,
  id: DocumentId,
): Promise<DocumentContent | null> {
  const [row] = await ctx.db
    .select({ ...META, bytes: documents.bytes })
    .from(documents)
    .where(and(eq(documents.businessId, ctx.businessId), eq(documents.id, id)));
  if (!row) return null;
  const { bytes, ...meta } = row;
  return { document: toRecord(meta), bytes };
}

export async function findDocumentBySha256(
  ctx: RepoCtx,
  sha256: string,
): Promise<DocumentRecord | null> {
  const [row] = await ctx.db
    .select(META)
    .from(documents)
    .where(and(eq(documents.businessId, ctx.businessId), eq(documents.sha256, sha256)));
  return row ? toRecord(row) : null;
}

/** Newest first, metadata only. */
export async function listDocuments(ctx: RepoCtx, limit = 100): Promise<DocumentRecord[]> {
  const rows = await ctx.db
    .select(META)
    .from(documents)
    .where(eq(documents.businessId, ctx.businessId))
    .orderBy(desc(documents.createdAt), desc(documents.id))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map(toRecord);
}
