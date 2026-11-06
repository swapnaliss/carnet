// Content validation by bytes, never by name or declared type (M2-01, architecture §8). Pure: the
// PDF page count and encryption check need a parser and live in the web app (unpdf); this decides the
// type and refuses what the bytes alone already show is wrong.
import { DOCUMENT_TYPES, type DocumentMime } from "./types";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_IHDR = [0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52];
const PNG_IEND = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
const JPEG_EOI = [0xff, 0xd9];
const PDF_EOF = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF
// ZIP end-of-central-directory and local-file-header signatures.
const ZIP_EOCD = [0x50, 0x4b, 0x05, 0x06];
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];
/** A ZIP reader finds the end-of-central-directory record within this many bytes of the end. */
const ZIP_EOCD_WINDOW = 22 + 0xffff;
/** PDF readers look for %%EOF within the last 1024 bytes. */
const PDF_EOF_WINDOW = 1024;
/** Whitespace a PDF writer may leave after %%EOF. */
const PDF_TRAILING = new Set([0x0a, 0x0d, 0x20, 0x09, 0x00]);

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

function endsWith(bytes: Uint8Array, sig: readonly number[]): boolean {
  return startsWith(bytes, sig, bytes.length - sig.length);
}

/** Index of `sig` in `bytes[from..]`, or -1. */
function indexOf(bytes: Uint8Array, sig: readonly number[], from = 0): number {
  const first = sig[0];
  const last = bytes.length - sig.length;
  for (let i = Math.max(0, from); i <= last; i++) {
    if (bytes[i] === first && startsWith(bytes, sig, i)) return i;
  }
  return -1;
}

/** The type the leading bytes declare, or null when they match none of the three. */
export function detectDocumentType(bytes: Uint8Array): DocumentMime | null {
  if (startsWith(bytes, PDF_MAGIC)) return "application/pdf";
  if (startsWith(bytes, PNG_MAGIC)) return "image/png";
  if (startsWith(bytes, JPEG_MAGIC)) return "image/jpeg";
  return null;
}

export type ByteInspection =
  | { readonly ok: true; readonly mime: DocumentMime; readonly ext: string }
  | { readonly ok: false; readonly reason: "UNSUPPORTED_TYPE" | "CORRUPT_FILE" };

/**
 * Decides the stored type from the bytes and refuses:
 * - anything that is not PDF, JPEG or PNG by its magic bytes (`UNSUPPORTED_TYPE`)
 * - a polyglot: a supported header with a ZIP archive in the body (`UNSUPPORTED_TYPE`)
 * - a truncated or malformed container: a PDF without `%%EOF` at its end, a JPEG without its
 *   end-of-image marker, a PNG without IHDR first and IEND last (`CORRUPT_FILE`)
 * A PDF that passes still needs the parser check (pages, encryption) before it is stored.
 */
export function inspectDocumentBytes(bytes: Uint8Array): ByteInspection {
  const mime = detectDocumentType(bytes);
  if (!mime) return { ok: false, reason: "UNSUPPORTED_TYPE" };
  // A ZIP reader opens the file when it finds an end-of-central-directory record near the end, and a
  // ZIP body right after the header is the other common polyglot shape.
  if (indexOf(bytes, ZIP_EOCD, bytes.length - ZIP_EOCD_WINDOW) >= 0) {
    return { ok: false, reason: "UNSUPPORTED_TYPE" };
  }
  if (indexOf(bytes.subarray(0, 1024), ZIP_LOCAL) >= 0) {
    return { ok: false, reason: "UNSUPPORTED_TYPE" };
  }
  switch (mime) {
    case "application/pdf": {
      let end = bytes.length;
      while (end > 0 && PDF_TRAILING.has(bytes[end - 1] ?? -1)) end--;
      const tail = bytes.subarray(Math.max(0, end - PDF_EOF_WINDOW), end);
      if (!endsWith(tail, PDF_EOF)) return { ok: false, reason: "CORRUPT_FILE" };
      break;
    }
    case "image/jpeg":
      if (bytes.length < 4 || !endsWith(bytes, JPEG_EOI)) {
        return { ok: false, reason: "CORRUPT_FILE" };
      }
      break;
    case "image/png":
      if (!startsWith(bytes, PNG_IHDR, PNG_MAGIC.length) || !endsWith(bytes, PNG_IEND)) {
        return { ok: false, reason: "CORRUPT_FILE" };
      }
      break;
  }
  return { ok: true, mime, ext: DOCUMENT_TYPES[mime] };
}
