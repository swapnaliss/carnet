// PDF structure check (M2-01): unpdf (pdf.js) parses the file only to count pages and to detect
// encryption. Nothing is rendered and no PDF script runs: pdf.js executes document JavaScript only in
// a viewer with `enableScripting` (never set here), the bundled pdf.js (unpdf 2.1.0) contains no
// `eval` or `new Function`, and XFA forms and font loading are off.
import { MAX_PDF_PAGES } from "@carnet/domain";
import { getDocumentProxy } from "unpdf";

export type PdfCheck =
  | { readonly ok: true; readonly pages: number }
  | { readonly ok: false; readonly reason: "TOO_MANY_PAGES" | "ENCRYPTED_PDF" | "CORRUPT_FILE" };

export const PDF_PARSE_TIMEOUT_MS = 10_000;

class PdfTimeout extends Error {
  override readonly name = "PdfTimeout";
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PdfTimeout(`pdf parse exceeded ${ms} ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function isPasswordError(error: unknown): boolean {
  return error instanceof Error && error.name === "PasswordException";
}

/** Page count and encryption of a PDF the magic-byte check already accepted. */
export async function checkPdf(
  bytes: Uint8Array,
  options: { maxPages?: number; timeoutMs?: number } = {},
): Promise<PdfCheck> {
  const maxPages = options.maxPages ?? MAX_PDF_PAGES;
  const timeoutMs = options.timeoutMs ?? PDF_PARSE_TIMEOUT_MS;
  let doc: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    // pdf.js takes ownership of (detaches) the buffer it is given: pass a copy.
    doc = await withTimeout(
      getDocumentProxy(bytes.slice(), {
        enableXfa: false,
        disableFontFace: true,
        useSystemFonts: false,
        stopAtErrors: true,
        verbosity: 0,
      }),
      timeoutMs,
    );
    const { info } = await withTimeout(doc.getMetadata(), timeoutMs);
    // A PDF with only an owner password opens without one; the trailer's /Encrypt still says so.
    if ((info as { EncryptFilterName?: unknown }).EncryptFilterName) {
      return { ok: false, reason: "ENCRYPTED_PDF" };
    }
    const pages = doc.numPages;
    if (!Number.isInteger(pages) || pages < 1) return { ok: false, reason: "CORRUPT_FILE" };
    if (pages > maxPages) return { ok: false, reason: "TOO_MANY_PAGES" };
    // The page tree must resolve, not just declare a count.
    await withTimeout(doc.getPage(1), timeoutMs);
    return { ok: true, pages };
  } catch (error) {
    if (isPasswordError(error)) return { ok: false, reason: "ENCRYPTED_PDF" };
    return { ok: false, reason: "CORRUPT_FILE" };
  } finally {
    await doc?.loadingTask.destroy().catch(() => undefined);
  }
}
