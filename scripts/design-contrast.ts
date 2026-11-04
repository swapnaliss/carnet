// `npm run design:contrast`: every text/background token pair listed in docs/design/tokens.md (the
// `contrast-pairs` block) must meet WCAG 2.2 AA in light and dark: 4.5:1 for body text, 3:1 for large
// text and UI. Colours come from docs/design/tokens.css (6-digit hex only). Exits non-zero on a
// failure, an unknown token or an unparsable value.
//
// Usage: node scripts/design-contrast.ts [tokens.css] [tokens.md]
import { readFileSync } from "node:fs";

type Theme = "light" | "dark";
type Kind = "body" | "large" | "ui";

const MIN: Record<Kind, number> = { body: 4.5, large: 3, ui: 3 };

const cssPath = process.argv[2] ?? "docs/design/tokens.css";
const mdPath = process.argv[3] ?? "docs/design/tokens.md";

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Body of the first `{...}` block that starts at or after `from`, with nested braces matched. */
function blockBody(css: string, from: number): string {
  const open = css.indexOf("{", from);
  if (open < 0) throw new Error(`no block after offset ${from}`);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("unbalanced braces in tokens.css");
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out.set(m[1] as string, (m[2] as string).trim());
  }
  return out;
}

export function parseThemes(cssText: string): Record<Theme, Map<string, string>> {
  const css = stripComments(cssText);
  // Light: the first top-level `:root {` (not inside a media query, not an attribute selector).
  const lightAt = css.search(/(^|\n)\s*:root\s*\{/);
  if (lightAt < 0) throw new Error("tokens.css: no top-level :root block");
  const light = declarations(blockBody(css, lightAt));

  const mediaAt = css.search(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)/);
  if (mediaAt < 0) throw new Error("tokens.css: no @media (prefers-color-scheme: dark) block");
  const mediaBody = blockBody(css, mediaAt);
  const innerAt = mediaBody.search(/:root[^{]*\{/);
  if (innerAt < 0) throw new Error("tokens.css: no :root block inside the dark media query");
  const darkOverrides = declarations(blockBody(mediaBody, innerAt));

  // Dark inherits every light value it does not override, exactly as the cascade does.
  const dark = new Map([...light, ...darkOverrides]);
  return { light, dark };
}

export function parsePairs(md: string): Array<{ fg: string; bg: string; kind: Kind }> {
  const block = md.match(/```contrast-pairs\n([\s\S]*?)```/);
  if (!block) throw new Error("tokens.md: no ```contrast-pairs block");
  const pairs: Array<{ fg: string; bg: string; kind: Kind }> = [];
  for (const raw of (block[1] as string).split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [fg, bg, kind, ...rest] = line.split(/\s+/);
    if (
      !fg?.startsWith("--") ||
      !bg?.startsWith("--") ||
      rest.length > 0 ||
      !(kind && kind in MIN)
    ) {
      throw new Error(`tokens.md: bad contrast-pairs line: "${raw}"`);
    }
    pairs.push({ fg, bg, kind: kind as Kind });
  }
  if (pairs.length === 0) throw new Error("tokens.md: the contrast-pairs block is empty");
  return pairs;
}

function channel(hex: string, offset: number): number {
  const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of a `#rrggbb` colour. */
export function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`not a 6-digit hex colour: ${hex}`);
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function main(): number {
  const themes = parseThemes(readFileSync(cssPath, "utf8"));
  const pairs = parsePairs(readFileSync(mdPath, "utf8"));
  let failures = 0;
  for (const theme of ["light", "dark"] as const) {
    for (const { fg, bg, kind } of pairs) {
      const a = themes[theme].get(fg);
      const b = themes[theme].get(bg);
      if (!a || !b) {
        console.error(`FAIL ${theme} ${fg} on ${bg}: token not defined in ${cssPath}`);
        failures++;
        continue;
      }
      let ratio: number;
      try {
        ratio = contrast(a, b);
      } catch (error) {
        console.error(`FAIL ${theme} ${fg} on ${bg}: ${(error as Error).message}`);
        failures++;
        continue;
      }
      const ok = ratio >= MIN[kind];
      if (!ok) failures++;
      const line = `${ok ? "ok  " : "FAIL"} ${theme.padEnd(5)} ${ratio.toFixed(2).padStart(5)}:1 >= ${MIN[kind]} (${kind}) ${fg} ${a} on ${bg} ${b}`;
      (ok ? console.log : console.error)(line);
    }
  }
  console.log(
    `\n${pairs.length * 2 - failures}/${pairs.length * 2} pairs pass WCAG AA (light and dark)`,
  );
  return failures === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`design:contrast: ${(error as Error).message}`);
    process.exitCode = 2;
  }
}
