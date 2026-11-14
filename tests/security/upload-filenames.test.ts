// STRIDE "Denial of service: upload abuse" / uploads (architecture §8): hostile filenames.
import { sanitizeFilename } from "@carnet/domain";
import { describe, expect, it } from "vitest";

const SAFE = /^[A-Za-z0-9 ._()-]+$/;

describe("Upload filename tricks", () => {
  const hostile: [string, string][] = [
    ["path traversal", "../../etc/passwd"],
    ["windows traversal", "..\\..\\windows\\system32\\config"],
    ["absolute path", "/etc/shadow"],
    ["null byte", "invoice.pdf\u0000.exe"],
    ["right-to-left override", "invoice‮fdp.exe"],
    ["zero-width characters", "inv​oice‍.pdf"],
    ["double extension", "invoice.php.pdf"],
    ["html in name", '"><script>alert(1)</script>.pdf'],
    ["header injection", 'a.pdf"\r\nContent-Type: text/html'],
    ["unicode confusables", "ｉｎｖｏｉｃｅ.pdf"],
    ["only dots", "......"],
    ["empty", ""],
    ["very long", `${"a".repeat(500)}.pdf`],
    ["emoji", "📄📄📄.pdf"],
  ];

  it.each(hostile)("%s becomes a safe name of at most 50 characters ending .pdf", (_l, raw) => {
    const out = sanitizeFilename(raw, "pdf");
    expect(out).toMatch(SAFE);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith(".pdf")).toBe(true);
    expect(out).not.toMatch(/\.\.|[\\/]|\u0000/);
    expect(out.startsWith(".")).toBe(false);
  });

  it("uses the extension the bytes decided, never the client's", () => {
    expect(sanitizeFilename("photo.pdf", "jpg")).toBe("photo.jpg");
    expect(sanitizeFilename("invoice.php.pdf", "pdf").endsWith(".php.pdf")).toBe(false);
  });

  it("null, undefined and non-strings fall back to a fixed name", () => {
    expect(sanitizeFilename(null, "pdf")).toBe("document.pdf");
    expect(sanitizeFilename(undefined, "png")).toBe("document.png");
  });
});
