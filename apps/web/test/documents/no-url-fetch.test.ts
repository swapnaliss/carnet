// M2-01 AC 11 / scope 6: nothing in the workspace downloads a URL a user supplied. A heuristic lint:
// every server-side `fetch(` / `http(s).get|request(` call in apps/web/src and packages must take a
// URL that is not derived from a request, body, input or document, and no documents endpoint
// declares a url-ish field.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SCAN = [
  "apps/web/src",
  "packages/domain/src",
  "packages/db/src",
  "packages/agent/src",
  "packages/airwallex/src",
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules" || name === ".next") return [];
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

/** A fetch whose first argument starts from request-controlled data. */
const TAINTED_FETCH =
  /\b(?:fetch|got|axios(?:\.\w+)?|https?\.(?:get|request)|undici\.(?:request|fetch))\(\s*(?:`[^`]*\$\{\s*)?(?:req(?:uest)?\b|body\b|input\b|url\b|params\b|query\b|form\b|file\b|doc(?:ument)?\b|user\w*\b|payload\b|searchParams\b)/;

describe("no server-side fetch of a user-supplied URL", () => {
  const files = SCAN.flatMap((d) => sources(join(ROOT, d)));

  it("scans the workspace", () => expect(files.length).toBeGreaterThan(30));

  // The Airwallex client builds every URL from its configured base URL plus a fixed path; `input` there
  // is the parameter name of its fetch wrapper, not user data. Reviewed in M0-04. The agent harness (M2-00) wraps the SDK's fixed Anthropic endpoint
  // the same way: `input` is the transport parameter.
  const ALLOWED = new Set(["packages/airwallex/src/http.ts", "packages/agent/src/harness.ts"]);

  it("no fetch/http call takes a request-derived URL", () => {
    const hits = files
      .filter((f) => !ALLOWED.has(relative(ROOT, f)))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .map((line, i) => ({ line, at: `${relative(ROOT, f)}:${i + 1}` }))
          .filter(({ line }) => TAINTED_FETCH.test(line)),
      );
    expect(hits.map((h) => `${h.at}  ${h.line.trim()}`)).toEqual([]);
  });

  it("the documents routes accept no url field and make no outbound call", () => {
    const docFiles = files.filter(
      (f) => /app\/api\/v1\/documents/.test(f) || /server\/documents\//.test(f),
    );
    expect(docFiles.length).toBeGreaterThanOrEqual(5);
    for (const f of docFiles) {
      const text = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
      expect(text, f).not.toMatch(
        /\bfetch\s*\(|https?\.(get|request)\s*\(|new URL\(|"url"|\burl:/i,
      );
    }
  });

  it("the lint catches what it claims to (self-test)", () => {
    expect(TAINTED_FETCH.test("const r = await fetch(body.url)")).toBe(true);
    expect(TAINTED_FETCH.test(["await fetch(`$", "{req.x}`)"].join(""))).toBe(true);
    expect(TAINTED_FETCH.test("await fetch(input)")).toBe(true);
    expect(TAINTED_FETCH.test("await fetch(AIRWALLEX_BASE + path)")).toBe(false);
  });
});
