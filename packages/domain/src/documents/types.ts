// Documents (M2-01, ADR 0003, architecture §8): the closed sets and limits every layer shares.
import { z } from "zod";
import type { ErrorCode } from "../errors";
import { DocumentIdSchema, IsoTimestampSchema } from "../schemas";

/** What the owner says a document is. The bytes, not this, decide the type. */
export const DOCUMENT_KINDS = [
  "invoice",
  "contract",
  "purchase_order",
  "statement",
  "other",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const DocumentKindSchema = z.enum(DOCUMENT_KINDS);

/** The only stored types, each derived from magic bytes, with the extension a filename gets. */
export const DOCUMENT_TYPES = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
} as const;
export type DocumentMime = keyof typeof DOCUMENT_TYPES;
export const DOCUMENT_MIMES = Object.keys(DOCUMENT_TYPES) as [DocumentMime, ...DocumentMime[]];
export const DocumentMimeSchema = z.enum(DOCUMENT_MIMES);

/** A PDF with more pages is refused (architecture §8). */
export const MAX_PDF_PAGES = 20;
/** The Airwallex file upload limit on names (docs/evidence/airwallex-rfi-contract.md). */
export const FILENAME_MAX_LENGTH = 50;
/** Defaults for the config keys of the same name (.env.example). */
export const DEFAULT_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_UPLOAD_SESSION_MAX_FILES = 10;
export const DEFAULT_UPLOAD_SESSION_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Stable reason codes for a refused upload. They travel in the ADR 0004 error as `details.reason`;
 * the HTTP status comes from the error code each one maps to.
 */
export const DOCUMENT_REJECT_REASONS = [
  "TOO_LARGE",
  "UNSUPPORTED_TYPE",
  "TOO_MANY_PAGES",
  "ENCRYPTED_PDF",
  "CORRUPT_FILE",
  "SESSION_CAP",
] as const;
export type DocumentRejectReason = (typeof DOCUMENT_REJECT_REASONS)[number];

export const DOCUMENT_REASON_ERROR = {
  TOO_LARGE: "PAYLOAD_TOO_LARGE",
  UNSUPPORTED_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  TOO_MANY_PAGES: "VALIDATION_FAILED",
  ENCRYPTED_PDF: "VALIDATION_FAILED",
  CORRUPT_FILE: "VALIDATION_FAILED",
  SESSION_CAP: "RATE_LIMITED",
} as const satisfies Record<DocumentRejectReason, ErrorCode>;

export const DOCUMENT_REASON_MESSAGE: Record<DocumentRejectReason, string> = {
  TOO_LARGE: "The file is too large.",
  UNSUPPORTED_TYPE: "Upload a PDF, JPEG or PNG file.",
  TOO_MANY_PAGES: `A PDF can have at most ${MAX_PDF_PAGES} pages.`,
  ENCRYPTED_PDF: "The PDF is password-protected or encrypted. Upload an unprotected copy.",
  CORRUPT_FILE: "The file could not be read. Upload it again or export a fresh copy.",
  SESSION_CAP: "Too many uploads from this session.",
};

/** Audit actions the documents routes write (never with file bytes). */
export const DOCUMENT_AUDIT_ACTIONS = {
  uploaded: "document.uploaded",
  deduplicated: "document.deduplicated",
  rejected: "document.upload_rejected",
  downloaded: "document.downloaded",
  /** M2-02: an owner confirmed (and possibly corrected) a document's extracted facts. */
  factsConfirmed: "document.facts_confirmed",
} as const;

/** `GET /api/v1/documents/{id}/meta`, and the body of a successful upload (plus `deduplicated`). */
export const DocumentMetaSchema = z.strictObject({
  id: DocumentIdSchema,
  kind: DocumentKindSchema,
  filename: z.string().min(1).max(FILENAME_MAX_LENGTH),
  mime: DocumentMimeSchema,
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  created_at: IsoTimestampSchema,
});
export type DocumentMeta = z.infer<typeof DocumentMetaSchema>;

export const DocumentUploadResponseSchema = DocumentMetaSchema.extend({
  deduplicated: z.boolean(),
});
export type DocumentUploadResponse = z.infer<typeof DocumentUploadResponseSchema>;
