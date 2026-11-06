import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_REASON_ERROR,
  DOCUMENT_REJECT_REASONS,
  DocumentKindSchema,
  detectDocumentType,
  ERROR_HTTP_STATUS,
  inspectDocumentBytes,
  sanitizeFilename,
} from "../src/index";

const dataset = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../fixtures/dataset/${name}`, import.meta.url)));
const ascii = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
// A minimal ZIP: one stored entry plus the central directory and its end record.
const ZIP = concat(
  Uint8Array.from([0x50, 0x4b, 0x03, 0x04]),
  new Uint8Array(26),
  ascii("payload"),
  Uint8Array.from([0x50, 0x4b, 0x01, 0x02]),
  new Uint8Array(42),
  Uint8Array.from([0x50, 0x4b, 0x05, 0x06]),
  new Uint8Array(18),
);

describe("detectDocumentType / inspectDocumentBytes (by bytes, never by name)", () => {
  it("accepts the dataset's PDF, JPEG and PNG", () => {
    expect(inspectDocumentBytes(dataset("inv-harbor-001.pdf"))).toEqual({
      ok: true,
      mime: "application/pdf",
      ext: "pdf",
    });
    expect(inspectDocumentBytes(dataset("scans/inv-nordlicht-scan-001.jpg"))).toEqual({
      ok: true,
      mime: "image/jpeg",
      ext: "jpg",
    });
    expect(inspectDocumentBytes(dataset("scans/inv-nordlicht-scan-001.png"))).toEqual({
      ok: true,
      mime: "image/png",
      ext: "png",
    });
  });

  it.each([
    ["an .exe (MZ header)", concat(ascii("MZ"), new Uint8Array(200))],
    ["HTML", ascii("<!doctype html><html><script>alert(1)</script></html>")],
    ["SVG", ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["a ZIP", ZIP],
    ["an empty file", new Uint8Array(0)],
    ["a BOM then %PDF-", concat(Uint8Array.from([0xef, 0xbb, 0xbf]), ascii("%PDF-1.7\n%%EOF"))],
  ])("refuses %s as UNSUPPORTED_TYPE", (_label, bytes) => {
    expect(detectDocumentType(bytes)).toBeNull();
    expect(inspectDocumentBytes(bytes)).toEqual({ ok: false, reason: "UNSUPPORTED_TYPE" });
  });

  it("refuses polyglots: PDF header with a ZIP body, a valid PDF with a ZIP appended, PNG + ZIP", () => {
    const pdf = dataset("inv-harbor-001.pdf");
    const png = dataset("scans/inv-nordlicht-scan-001.png");
    for (const bytes of [
      concat(ascii("%PDF-1.7\n"), ZIP),
      concat(ascii("%PDF-1.7\n"), ZIP, ascii("\n%%EOF\n")),
      concat(pdf, ZIP),
      concat(png, ZIP),
    ]) {
      const r = inspectDocumentBytes(bytes);
      expect(r.ok).toBe(false);
      expect(["UNSUPPORTED_TYPE", "CORRUPT_FILE"]).toContain(r.ok ? "" : r.reason);
    }
  });

  it("refuses truncated containers as CORRUPT_FILE", () => {
    const pdf = dataset("inv-harbor-001.pdf");
    const jpg = dataset("scans/inv-nordlicht-scan-001.jpg");
    const png = dataset("scans/inv-nordlicht-scan-001.png");
    for (const bytes of [
      pdf.subarray(0, pdf.length - 2000),
      jpg.subarray(0, jpg.length - 10),
      png.subarray(0, png.length - 5),
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ]) {
      expect(inspectDocumentBytes(bytes)).toEqual({ ok: false, reason: "CORRUPT_FILE" });
    }
  });

  it("PNG bytes under a .pdf name are a PNG", () => {
    expect(detectDocumentType(dataset("scans/inv-nordlicht-scan-001.png"))).toBe("image/png");
    expect(sanitizeFilename("invoice.pdf", "png")).toBe("invoice.png");
  });
});

describe("sanitizeFilename", () => {
  it.each([
    ["../../x", "pdf", "x.pdf"],
    ["..\\..\\windows\\system32\\evil.exe", "pdf", "evil.pdf"],
    ["......", "pdf", "document.pdf"],
    ["", "png", "document.png"],
    ['in"vo;ice\r\n.pdf', "pdf", "in_vo_ice.pdf"],
    ["Rechnung Müller – März.pdf", "pdf", "Rechnung Muller _ Marz.pdf"],
    ["inv‮gpj.exe", "pdf", "invgpj.pdf"],
    ["report 2026.11", "pdf", "report 2026.11.pdf"],
    [".htaccess", "png", "htaccess.png"],
    ["-rf", "jpg", "rf.jpg"],
  ])("%j → %j", (raw, ext, expected) => {
    expect(sanitizeFilename(raw, ext)).toBe(expected);
  });

  it("truncates to 50 characters and keeps the detected extension", () => {
    const out = sanitizeFilename(`${"a".repeat(300)}.pdf`, "pdf");
    expect(out).toHaveLength(50);
    expect(out.endsWith(".pdf")).toBe(true);
  });
});

describe("kinds and reasons", () => {
  it("kind is a closed set", () => {
    expect(DocumentKindSchema.safeParse("invoice").success).toBe(true);
    expect(DocumentKindSchema.safeParse("passport").success).toBe(false);
  });

  it("every reason maps to an API error code with the documented status", () => {
    const statuses = Object.fromEntries(
      DOCUMENT_REJECT_REASONS.map((r) => [r, ERROR_HTTP_STATUS[DOCUMENT_REASON_ERROR[r]]]),
    );
    expect(statuses).toEqual({
      TOO_LARGE: 413,
      UNSUPPORTED_TYPE: 415,
      TOO_MANY_PAGES: 400,
      ENCRYPTED_PDF: 400,
      CORRUPT_FILE: 400,
      SESSION_CAP: 429,
    });
  });
});
