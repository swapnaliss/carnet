import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// The follow-up round on the hold screen (M3-05) against the production build and a database seeded with
// REAL pipeline output over recorded responses (apps/web/e2e/fixtures/seed-follow-up.ts). Needs
// DATABASE_URL, SEED_OWNER_PASSWORD and the web server started on the same database; otherwise skipped.
// Screenshots go to SHOTS_DIR (the ui-reviewer run uses .review/M3-05).
const password = process.env.SEED_OWNER_PASSWORD;
test.skip(
  !password || !process.env.DATABASE_URL,
  "DATABASE_URL and SEED_OWNER_PASSWORD are not set.",
);
test.describe.configure({ mode: "serial" });

const SHOTS = process.env.SHOTS_DIR ?? join(process.env.TMPDIR ?? "/tmp", "m3-05-shots");
mkdirSync(SHOTS, { recursive: true });
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
let ids: Record<string, { id: string }> = {};

test.beforeAll(() => {
  test.setTimeout(180_000);
  const out = execFileSync("npx", ["tsx", "apps/web/e2e/fixtures/seed-follow-up.ts"], {
    encoding: "utf8",
    env: process.env,
    timeout: 170_000,
  });
  ids = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
});

async function open(page: Page, name: string) {
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: "owner@carnet.example", password },
  });
  expect(res.status(), await res.text()).toBe(200);
  await page.goto(`/rfis/${ids[name]?.id}`);
  await expect(page.getByTestId("hold-screen")).toBeVisible();
}

async function capture(page: Page, name: string) {
  const each = async (shot: (scheme: string, width: number) => Promise<void>) => {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [375, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await shot(scheme, width);
      }
    }
  };
  // First what a user sees on arrival, with the sticky approval bar where it sits.
  await each(async (scheme, width) => {
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}-${width}-viewport.png`) });
  });
  // Then the whole page; the bar is un-stuck for these only, so it does not cover the content.
  const unstick = await page.addStyleTag({
    content: '[data-testid="approval-bar"]{position:static !important}',
  });
  await each(async (scheme, width) => {
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}-${width}.png`), fullPage: true });
  });
  await unstick.evaluate((el) => (el as Element).remove());
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function axe(page: Page, name: string) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(SHOTS, `axe-${name}.json`), JSON.stringify(results.violations, null, 1));
}

test("all reused: 'Same as approved on <date>', then one click applies them as a new approval", async ({
  page,
}) => {
  await open(page, "reused");
  await expect(page.getByTestId("follow-up-panel")).toContainText("Round 2");
  await expect(page.getByTestId("follow-up-badge")).toHaveText("Reused");
  await expect(page.getByTestId("same-as-approved")).toContainText("Same as approved on");
  await capture(page, "reused");
  await axe(page, "reused");
  const apply = page.getByTestId("apply-reused");
  await expect(apply).toHaveText("Apply all reused answers");
  await apply.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("hold-screen")).toHaveAttribute("data-rfi-state", "APPROVED", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("approval-status")).toBeVisible();
});

test("a question that needs you blocks the whole request and names the question", async ({
  page,
}) => {
  await open(page, "mixed");
  const blocked = page.getByTestId("follow-up-blocked");
  await expect(blocked).toContainText("The whole request is blocked");
  await expect(blocked).toContainText("Question 2");
  await expect(page.getByTestId("follow-up-badge")).toHaveText("Reused");
  await expect(page.getByTestId("question-status").nth(1)).toHaveText("Needs you");
  await expect(page.getByTestId("apply-reused")).toHaveCount(0);
  await expect(page.getByTestId("approve-button")).toHaveAttribute("aria-disabled", "true");
  await capture(page, "blocked");
  await axe(page, "blocked");
});

test("a changed question is a new draft and shows the earlier and the new wording", async ({
  page,
}) => {
  await open(page, "changed");
  await expect(page.getByTestId("follow-up-badge")).toHaveText("New draft");
  await expect(page.getByTestId("diff-old")).toContainText("Describe what this payment is for.");
  await expect(page.getByTestId("diff-new")).toContainText("the goods it covers");
  await expect(page.getByTestId("same-as-approved")).toHaveCount(0);
  await capture(page, "changed");
  await axe(page, "changed");
});
