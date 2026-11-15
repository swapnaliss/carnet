import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// packages/domain imports no framework, SDK or I/O (ADR 0001).
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
  });
}

const FORBIDDEN_MODULE =
  /^(pg|drizzle-orm|drizzle-kit|next|react|react-dom|@anthropic-ai\/sdk|better-auth|pino|unpdf|pdfkit|fs|http|https|net|child_process|node:.*)(\/.*)?$/;
const ALLOWED_MODULE = /^(zod|\.\.?\/.*)$/;

describe("packages/domain purity", () => {
  const files = sources(SRC);

  it("finds the source files", () => expect(files.length).toBeGreaterThanOrEqual(6));

  it.each(files)("%s imports only zod and relative modules", (file) => {
    const text = readFileSync(file, "utf8");
    const specs = [
      ...text.matchAll(/(?:^|\s)(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g),
      ...text.matchAll(/(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...text.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ].map((m) => m[1] ?? "");
    for (const spec of specs) {
      expect(FORBIDDEN_MODULE.test(spec), `${file}: forbidden import ${spec}`).toBe(false);
      expect(ALLOWED_MODULE.test(spec), `${file}: import outside the allowlist ${spec}`).toBe(true);
    }
  });

  it.each(files)("%s makes no network or file calls", (file) => {
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/\bfetch\s*\(/);
    expect(text).not.toMatch(/\bXMLHttpRequest\b|\bWebSocket\b/);
    expect(text).not.toMatch(/\bprocess\.env\b/);
  });

  it("the detector catches a forbidden import", () => {
    expect(FORBIDDEN_MODULE.test("pg")).toBe(true);
    expect(FORBIDDEN_MODULE.test("node:fs")).toBe(true);
    expect(FORBIDDEN_MODULE.test("next/server")).toBe(true);
    expect(FORBIDDEN_MODULE.test("@anthropic-ai/sdk")).toBe(true);
    expect(ALLOWED_MODULE.test("zod")).toBe(true);
    expect(ALLOWED_MODULE.test("./money")).toBe(true);
  });
});
