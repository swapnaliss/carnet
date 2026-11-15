import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";
import pg from "pg";

// Shared by the M4-07 accessibility suite (apps/web/e2e/a11y): sign-in, seeding through the existing
// fixtures (real pipeline output over recorded responses; no Airwallex or model call), and the axe run.
// Needs DATABASE_URL, the SEED_*_PASSWORD variables and the web server started with the same database.
export const passwords = {
  owner: process.env.SEED_OWNER_PASSWORD,
  judge: process.env.SEED_JUDGE_PASSWORD,
};
export const databaseUrl = process.env.DATABASE_URL;
export const hasStack = Boolean(passwords.owner && passwords.judge && databaseUrl);
export const SKIP_REASON = "DATABASE_URL and SEED_*_PASSWORD are not set; the a11y suite is skipped.";

/** WCAG 2.0, 2.1 and 2.2 at levels A and AA. */
export const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

/**
 * Rules excluded from the zero-violation bar, each with its justification. Empty: nothing is excluded.
 * Add an entry only with a written reason a reviewer can challenge (M4-07 Scope 1).
 */
export const EXCLUDED_RULES: ReadonlyArray<{ id: string; why: string }> = [];

export const AXE_DIR =
  process.env.A11Y_AXE_DIR ?? join(process.env.TMPDIR ?? "/tmp", "m4-07-axe");
mkdirSync(AXE_DIR, { recursive: true });

export async function signIn(page: Page, role: "owner" | "judge" = "owner"): Promise<void> {
  const email = role === "owner" ? "owner@carnet.example" : "judge@carnet.example";
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email, password: passwords[role] },
  });
  expect(res.status(), await res.text()).toBe(200);
}

/** Zero WCAG A/AA violations of any impact; the full result is written to AXE_DIR and attached. */
export async function expectNoAxeViolations(
  page: Page,
  name: string,
  info: TestInfo,
): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(TAGS)
    .disableRules(EXCLUDED_RULES.map((r) => r.id))
    .analyze();
  const file = name.replace(/[^a-z0-9-]+/gi, "_");
  writeFileSync(
    join(AXE_DIR, `${file}.json`),
    JSON.stringify(
      {
        url: results.url,
        violations: results.violations,
        passes: results.passes.length,
        incomplete: results.incomplete.length,
      },
      null,
      2,
    ),
  );
  await info.attach(`axe-${file}.json`, {
    body: JSON.stringify(results.violations, null, 2),
    contentType: "application/json",
  });
  expect(
    results.violations.map(
      (v) =>
        `${name}: ${v.impact ?? "?"} ${v.id}: ${v.help} -> ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join(" | ")}`,
    ),
  ).toEqual([]);
}

export interface SeededRfi {
  id: string;
  airwallexId: string;
  paymentId: string;
}

export const seedHold = (...args: string[]): string =>
  execFileSync("npx", ["tsx", "apps/web/e2e/fixtures/seed-hold.ts", ...args], {
    encoding: "utf8",
    env: process.env,
    timeout: 150_000,
  });

export function seedHoldWorld(): Record<string, SeededRfi> {
  const out = seedHold("seed").trim().split("\n").at(-1) ?? "{}";
  return JSON.parse(out) as Record<string, SeededRfi>;
}

/** The plan revisions (M3-04 fixture); prints the ids once, no-op when a plan exists. */
export function seedPlan(): void {
  execFileSync("npx", ["tsx", "apps/web/e2e/fixtures/seed-plan.ts", "seed"], {
    encoding: "utf8",
    env: process.env,
    timeout: 120_000,
  });
}

export async function withDb<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Presses Tab until `match` reports the focused element; fails after `max` presses. Keyboard only. */
export async function tabUntil(
  page: Page,
  match: () => Promise<boolean>,
  what: string,
  opts: { max?: number; back?: boolean; onStop?: () => Promise<void> } = {},
): Promise<void> {
  const max = opts.max ?? 120;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(opts.back ? "Shift+Tab" : "Tab");
    if (opts.onStop) await opts.onStop();
    if (await match()) return;
  }
  throw new Error(`keyboard: ${what} not reached in ${max} Tab presses`);
}

/** WCAG relative-luminance contrast of two CSS rgb()/rgba() colours (alpha ignored). */
export function contrastOf(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = (c.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map((v) => {
      const s = Number(v) / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The focused element's visible indicator: outline (or box-shadow ring) width >= 2 px and >= 3:1
 * against the nearest opaque background behind it. Returns a description on failure, null when fine.
 */
export async function focusIndicatorProblem(page: Page): Promise<string | null> {
  const info = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    let bg = "rgb(255, 255, 255)";
    for (let n: HTMLElement | null = el.parentElement; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && !/rgba\(.*,\s*0\)$/.test(c) && c !== "transparent") {
        bg = c;
        break;
      }
      if (n === document.documentElement) bg = getComputedStyle(document.body).backgroundColor;
    }
    const ring = /(rgba?\([^)]*\))\s+0px\s+0px\s+0px\s+(\d+(?:\.\d+)?)px/.exec(cs.boxShadow);
    return {
      tag: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}[${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}]`,
      outlineStyle: cs.outlineStyle,
      outlineWidth: Number.parseFloat(cs.outlineWidth),
      outlineColor: cs.outlineColor,
      ringColor: ring?.[1] ?? null,
      ringWidth: ring ? Number(ring[2]) : 0,
      bg,
    };
  });
  if (!info) return "nothing is focused";
  const outline = info.outlineStyle !== "none" && info.outlineWidth >= 2;
  const color = outline ? info.outlineColor : info.ringColor;
  const width = outline ? info.outlineWidth : info.ringWidth;
  if (!color || width < 2) return `${info.tag}: no >= 2px focus indicator`;
  const ratio = contrastOf(color, info.bg);
  if (ratio < 3) return `${info.tag}: focus indicator ${color} on ${info.bg} is ${ratio.toFixed(2)}:1`;
  return null;
}
