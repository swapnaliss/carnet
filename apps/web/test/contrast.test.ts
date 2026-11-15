import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, parsePairs, parseThemes } from "../../../scripts/design-contrast.ts";

// M4-07 Scope 4: every foreground/background token pair in docs/design meets WCAG 2.2 AA in light and
// dark (4.5:1 body text, 3:1 large text and UI components). The pair list is the `contrast-pairs` block
// of docs/design/tokens.md; this test also proves that list is complete for the token naming scheme
// (every `--x-foreground` is paired with `--x`, every `--status-*-fg` with its `--status-*-bg`), so a new
// token cannot skip the check. Colours come from docs/design/tokens.css, the source the app copies.
const repo = join(import.meta.dirname, "../../..");
const css = readFileSync(join(repo, "docs/design/tokens.css"), "utf8");
const md = readFileSync(join(repo, "docs/design/tokens.md"), "utf8");
const themes = parseThemes(css);
const pairs = parsePairs(md);
const MIN = { body: 4.5, large: 3, ui: 3 } as const;

describe("design token contrast (WCAG 2.2 AA)", () => {
  it("lists a non-trivial set of pairs", () => {
    expect(pairs.length).toBeGreaterThan(20);
  });

  for (const theme of ["light", "dark"] as const) {
    for (const { fg, bg, kind } of pairs) {
      it(`${theme}: ${fg} on ${bg} >= ${MIN[kind]}:1 (${kind})`, () => {
        const a = themes[theme].get(fg);
        const b = themes[theme].get(bg);
        expect(a, `${fg} is defined in ${theme}`).toBeTruthy();
        expect(b, `${bg} is defined in ${theme}`).toBeTruthy();
        expect(contrast(a as string, b as string)).toBeGreaterThanOrEqual(MIN[kind]);
      });
    }
  }

  it("every foreground token is checked against its own background token", () => {
    const tokens = new Set(themes.light.keys());
    const listed = new Set(pairs.map((p) => `${p.fg} on ${p.bg}`));
    const expected: string[] = [];
    for (const name of tokens) {
      if (name.endsWith("-foreground") && name !== "--foreground") {
        const base = name.slice(0, -"-foreground".length);
        if (tokens.has(base)) expected.push(`${name} on ${base}`);
      }
      if (/^--status-[a-z]+-fg$/.test(name)) expected.push(`${name} on ${name.replace(/-fg$/, "-bg")}`);
    }
    expected.push("--foreground on --background");
    expect(expected.filter((e) => !listed.has(e))).toEqual([]);
  });

  it("the focus ring is >= 3:1 against the page background in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const ring = themes[theme].get("--focus-ring") as string;
      const page = themes[theme].get("--background") as string;
      expect(contrast(ring, page)).toBeGreaterThanOrEqual(3);
    }
  });
});
