import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// /ops governance panel (M4-02): the owner pauses and resumes both switches with the keyboard, sees the
// state change only after the server confirms, sees spend against the caps and the breaker state; an
// approver sees the state but has no buttons. Needs the web server started with DATABASE_URL and
// BETTER_AUTH_* and the demo users seeded (`npx tsx packages/db/src/seed/run.ts`); without the SEED_*
// passwords the tests are skipped loudly. Screenshots go to SHOTS_DIR (default $TMPDIR/m4-02-shots).
const passwords = {
  owner: process.env.SEED_OWNER_PASSWORD,
  approver: process.env.SEED_APPROVER_PASSWORD,
};
const emails = { owner: "owner@carnet.example", approver: "approver@carnet.example" } as const;

test.skip(
  !passwords.owner || !passwords.approver,
  "SEED_OWNER_PASSWORD and SEED_APPROVER_PASSWORD are not set; kill-switch e2e skipped.",
);
test.describe.configure({ mode: "serial" });

const SHOTS = process.env.SHOTS_DIR ?? join(process.env.TMPDIR ?? "/tmp", "m4-02-shots");
mkdirSync(SHOTS, { recursive: true });
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const ORIGIN =
  process.env.E2E_BASE_URL ?? `http://localhost:${3000 + Number(process.env.PORT_OFFSET ?? 0)}`;
const headers = { origin: ORIGIN };

async function signIn(page: Page, role: keyof typeof emails): Promise<void> {
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: emails[role], password: passwords[role] },
    headers,
  });
  expect(res.status(), await res.text()).toBe(200);
}

async function flip(page: Page, flag: "agents_enabled" | "execution_enabled", enabled: boolean) {
  const res = await page.request.post("/api/ops/flags", { data: { flag, enabled }, headers });
  expect(res.status(), await res.text()).toBe(200);
}

test.afterEach(async ({ page }) => {
  // Always leave both switches on, whatever a test did.
  await signIn(page, "owner");
  await flip(page, "agents_enabled", true);
  await flip(page, "execution_enabled", true);
});

test("the owner pauses and resumes both switches with the keyboard", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, "owner");
  await flip(page, "agents_enabled", true);
  await flip(page, "execution_enabled", true);
  await page.goto("/ops");

  await expect(page.getByTestId("switch-execution_enabled-state")).toHaveText(/Execution is on/);
  await expect(page.getByTestId("switch-agents_enabled-state")).toHaveText(/Agents are on/);
  await expect(page.getByRole("heading", { name: "Model spend", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dependencies", exact: true })).toBeVisible();
  await expect(page.getByText("Spent today")).toBeVisible();
  await expect(page.getByText("Daily cap").first()).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "ops-on.png") });

  // Execution: keyboard only. Pausing asks for confirmation that repeats the effect.
  const exec = page.getByTestId("switch-execution_enabled-button");
  await exec.focus();
  await expect(exec).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Pause now? Execution" })).toBeVisible();
  await page.screenshot({ path: join(SHOTS, "ops-confirm.png") });
  await page.getByRole("button", { name: "Yes, pause" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("switch-execution_enabled-state")).toHaveText(
    /Execution is paused/,
  );
  await expect(page.getByTestId("switch-execution_enabled")).toContainText("Changed by");
  await page.screenshot({ path: join(SHOTS, "ops-paused.png") });

  // Agents too, then resume both.
  await page.getByTestId("switch-agents_enabled-button").focus();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Yes, pause" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("switch-agents_enabled-state")).toHaveText(/Agents are paused/);

  await page.getByTestId("switch-execution_enabled-button").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("switch-execution_enabled-state")).toHaveText(/Execution is on/);
  await page.getByTestId("switch-agents_enabled-button").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("switch-agents_enabled-state")).toHaveText(/Agents are on/);
  expect(errors).toEqual([]);

  // The server state agrees after a reload.
  await page.reload();
  await expect(page.getByTestId("switch-execution_enabled-state")).toHaveText(/Execution is on/);
});

test("the governance panel has no axe violations", async ({ page }) => {
  await signIn(page, "owner");
  await page.goto("/ops");
  await expect(page.getByTestId("switch-execution_enabled")).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400); // let the colour transitions settle before axe samples them
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  }
});

test("an approver sees the state and no buttons", async ({ page }) => {
  await signIn(page, "approver");
  await page.goto("/ops");
  await expect(page.getByTestId("switch-execution_enabled-state")).toBeVisible();
  await expect(page.getByTestId("switch-execution_enabled-button")).toHaveCount(0);
  await expect(page.getByText("Only the owner can change a switch.").first()).toBeVisible();
  const res = await page.request.post("/api/ops/flags", {
    data: { flag: "execution_enabled", enabled: false },
    headers,
  });
  expect(res.status()).toBe(403);
});
