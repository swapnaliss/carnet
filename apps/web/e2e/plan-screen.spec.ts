import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// The plan screen (M3-04) against the production build and a database seeded with the payroll-Friday
// revision pair through the real planner (apps/web/e2e/fixtures/seed-plan.ts). Needs DATABASE_URL, the
// SEED_*_PASSWORD variables and the web server started with the same database; without them the file is
// skipped loudly. Payout details come from Airwallex at render time and no Airwallex is reachable here,
// so the payout card shows its "cannot be approved yet" state; the bound payout approval itself is
// proven in apps/web/test/plans/plan-approve.int.test.ts over the recorded-response client.
// Screenshots go to SHOTS_DIR (default $TMPDIR/m3-04-shots); the ui-reviewer run uses .review/M3-04.
const passwords = {
  owner: process.env.SEED_OWNER_PASSWORD,
  viewer: process.env.SEED_JUDGE_PASSWORD,
};
test.skip(
  !passwords.owner || !passwords.viewer || !process.env.DATABASE_URL,
  "DATABASE_URL and SEED_*_PASSWORD are not set; plan-screen e2e skipped.",
);
test.describe.configure({ mode: "serial" });

const SHOTS = process.env.SHOTS_DIR ?? join(process.env.TMPDIR ?? "/tmp", "m3-04-shots");
mkdirSync(SHOTS, { recursive: true });
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const seed = (cmd: string) =>
  execFileSync("npx", ["tsx", "apps/web/e2e/fixtures/seed-plan.ts", cmd], {
    encoding: "utf8",
    env: process.env,
    timeout: 120_000,
  })
    .trim()
    .split("\n")
    .at(-1) as string;

test.beforeAll(() => {
  seed("users");
});

async function signIn(page: Page, role: "owner" | "viewer" = "owner"): Promise<void> {
  const email = role === "owner" ? "owner@carnet.example" : "judge@carnet.example";
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email, password: passwords[role] },
  });
  expect(res.status(), await res.text()).toBe(200);
}
const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
async function axe(page: Page, name: string) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad, `${name}: ${JSON.stringify(bad.map((v) => v.id))}`).toEqual([]);
}
const open = async (page: Page, role: "owner" | "viewer" = "owner", path = "/plans/current") => {
  await signIn(page, role);
  await page.goto(path);
  await expect(page.getByTestId("plan-screen")).toBeVisible();
};

test("with no plan yet the page says there are no obligations", async ({ page }) => {
  await signIn(page);
  await page.goto("/plans/current");
  const empty = await page.getByRole("heading", { name: "No obligations yet" }).count();
  test.skip(empty === 0, "a plan already exists in this database");
  await expect(page.getByRole("heading", { name: "Plan", level: 1 })).toBeVisible();
  await axe(page, "empty");
  await shot(page, "empty-1440");
});

test("the payroll-Friday pair: held funds unavailable, before and after, convert, fund, payout, defer", async ({
  page,
}) => {
  seed("seed");
  await open(page);
  await expect(page.getByTestId("plan-revision")).toHaveText("Revision 2");
  await expect(page.getByTestId("plan-trigger")).toContainText(
    "payment to Nordlicht Print GmbH is held for information",
  );
  await expect(page.getByTestId("plan-inputs-hash")).toContainText(/Inputs [0-9a-f]{8}/);
  const eur = page.getByTestId("balances-EUR");
  await expect(eur.locator('[data-row="held"]')).toContainText("Held, unavailable");
  await expect(eur.locator('[data-row="held"]')).toContainText("2,500.00");
  await expect(eur.getByRole("columnheader", { name: "Revision 1" })).toBeVisible();
  await expect(eur.getByTestId("delta-held")).toContainText("2,500.00");
  const kinds = await page
    .getByTestId("action-card")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
  expect(kinds.sort()).toEqual(["convert", "defer", "fund", "payout"]);
  await expect(page.getByTestId("explanation-text")).toContainText("is funded by converting USD");
  await expect(page.getByTestId("obligation-changed").first()).toBeVisible();
  // Payout details need Airwallex, which is not reachable here: the control is disabled and says why.
  const payout = page.locator('[data-testid="action-card"][data-kind="payout"]');
  await expect(payout.getByTestId("approve-button")).toBeDisabled();
  await expect(page.getByTestId("plan-airwallex-banner")).toBeVisible();
});

const widths = [375, 768, 1440];
for (const scheme of ["light", "dark"] as const) {
  for (const width of widths) {
    test(`screenshots and axe at ${width} ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      await axe(page, `${width}-${scheme}`);
      await shot(page, `plan-${width}-${scheme}`);
    });
  }
}

test("loading and error states render and pass axe", async ({ page }) => {
  await signIn(page);
  await page.goto("/plans/loading-preview");
  await expect(page.getByText("Loading the plan")).toBeVisible();
  await axe(page, "loading");
  await shot(page, "loading-1440");
  await page.goto("/plans/error-preview");
  await expect(page.getByRole("heading", { name: "Carnet could not load the plan" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await axe(page, "error");
  await shot(page, "error-1440");
});

test("a failed refresh shows the error with a retry, and the page keeps its last plan", async ({
  page,
}) => {
  await open(page);
  seed("next");
  await expect(page.getByTestId("plan-newer-banner")).toBeVisible({ timeout: 15_000 });
  await page.route("**/api/v1/plans/current", (route) =>
    route.fulfill({ status: 500, body: "{}" }),
  );
  await page.getByTestId("plan-show-latest").click();
  await expect(page.getByTestId("plan-load-error")).toBeVisible();
  await expect(page.getByTestId("plan-revision")).toHaveText("Revision 2");
  await shot(page, "load-error-1440");
  await page.unroute("**/api/v1/plans/current");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("plan-revision")).toHaveText("Revision 3");
});

test("an approval of the old revision is refused: 'plan changed', then the new plan", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/plans/2");
  await expect(page.getByTestId("plan-screen")).toBeVisible();
  // Revision 2 is no longer the newest, so it offers no approve control, and a forced call is refused.
  await expect(page.getByTestId("approve-button")).toHaveCount(0);
  await expect(page.getByTestId("plan-newer-banner")).toBeVisible({ timeout: 15_000 });
  const view = (await (await page.request.get("/api/v1/plans/current")).json()) as {
    plan: { actions: { id: string; kind: string; bound: Record<string, string> | null }[] };
  };
  const convert = view.plan.actions.find((a) => a.kind === "convert");
  const res = await page.request.post(`/api/v1/plan-actions/${convert?.id}/approve`, {
    headers: { "idempotency-key": "e2e-old-revision-0001" },
    data: { plan_revision: 2, shown: convert?.bound ?? {} },
  });
  expect(res.status()).toBe(409);
  expect(JSON.stringify(await res.json())).toContain("PLAN_CHANGED");
});

test("the page says 'plan changed' when the revision moves while the dialog is open", async ({
  page,
}) => {
  await open(page);
  const rev = Number((await page.getByTestId("plan-screen").getAttribute("data-revision")) ?? "0");
  await page
    .locator('[data-testid="action-card"][data-kind="convert"]')
    .getByTestId("approve-button")
    .click();
  await expect(page.getByTestId("plan-approve-dialog")).toBeVisible();
  seed("next");
  await page.getByTestId("plan-approve-confirm").click();
  await expect(page.getByTestId("plan-changed")).toBeVisible();
  await shot(page, "plan-changed-dialog");
  await page.getByTestId("plan-review-new").click();
  await expect(page.getByTestId("plan-changed-banner")).toBeVisible();
  await expect(page.getByTestId("plan-screen")).not.toHaveAttribute("data-revision", String(rev));
});

test("keyboard: tab to approve, Enter opens the dialog, Escape closes it and returns focus", async ({
  page,
}) => {
  await open(page);
  const button = page
    .locator('[data-testid="action-card"][data-kind="convert"]')
    .getByTestId("approve-button");
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("plan-approve-dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Approve this conversion" })).toBeFocused();
  await expect(
    page.getByTestId("plan-approve-dialog").locator("[data-field]").first(),
  ).toBeVisible();
  await shot(page, "dialog-1440");
  await axe(page, "dialog");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("plan-approve-dialog")).toBeHidden();
  await expect(button).toBeFocused();
});

test("criticality: unconfirmed first, a viewer sees it disabled, the owner confirms and the row shows who", async ({
  page,
  browser,
}) => {
  await open(page);
  const row = page.getByTestId("obligation-row").filter({ hasText: "Payroll (team)" });
  await expect(row.getByTestId("criticality-status")).toHaveText(
    "Unconfirmed, treated as most protective",
  );
  await expect(row.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(row.getByTestId("criticality-confirm")).toBeDisabled();

  const viewer = await browser.newPage();
  await open(viewer, "viewer");
  const vrow = viewer.getByTestId("obligation-row").filter({ hasText: "Payroll (team)" });
  await expect(vrow.getByRole("radio").first()).toBeDisabled();
  await expect(vrow.getByTestId("criticality-confirm")).toBeDisabled();
  await expect(vrow).toContainText("Only an owner or approver can confirm criticality.");
  await shot(viewer, "viewer-1440");
  await viewer.close();

  await row.getByRole("radio").nth(1).check();
  await row.getByTestId("criticality-confirm").click();
  await expect(row.getByTestId("criticality-status")).toContainText("confirmed by", {
    timeout: 15_000,
  });
  await expect(row.getByTestId("criticality-status")).toContainText("Criticality 2");
});

test("approving the conversion records an approval and the card says so", async ({ page }) => {
  await open(page);
  const card = page.locator('[data-testid="action-card"][data-kind="convert"]');
  await card.getByTestId("approve-button").click();
  await page.getByTestId("plan-approve-confirm").click();
  await expect(card).toHaveAttribute("data-state", "APPROVED", { timeout: 15_000 });
  await expect(card).toContainText("Approved");
  await shot(page, "approved-1440");
});

test("web vitals on the plan page (CI profile): LCP and CLS recorded", async ({ browser }) => {
  test.setTimeout(120_000);
  const out: string[] = [];
  for (const vp of [
    { w: 375, h: 812 },
    { w: 1440, h: 900 },
  ]) {
    const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await context.newPage();
    await signIn(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.addInitScript(() => {
      const w = window as unknown as { __lcp: number; __cls: number; __inp: number };
      w.__lcp = 0;
      w.__cls = 0;
      w.__inp = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__lcp = e.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as Array<
          PerformanceEntry & { value: number; hadRecentInput: boolean }
        >) {
          if (!e.hadRecentInput) w.__cls += e.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__inp = Math.max(w.__inp, e.duration);
      }).observe({
        type: "event",
        durationThreshold: 16,
        buffered: true,
      } as PerformanceObserverInit);
    });
    await page.goto("/plans/current", { waitUntil: "load" });
    await expect(page.getByTestId("plan-screen")).toBeVisible();
    await page.waitForTimeout(1_500);
    await page.waitForTimeout(2_000);
    await page.getByRole("radio").first().check();
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => {
      const w = window as unknown as { __lcp: number; __cls: number; __inp: number };
      return { lcp: w.__lcp, cls: w.__cls, inp: w.__inp };
    });
    out.push(
      `${vp.w}px: LCP ${Math.round(r.lcp)} ms, CLS ${r.cls.toFixed(4)}, INP ${Math.round(r.inp)} ms`,
    );
    expect(r.lcp).toBeLessThan(2_500);
    expect(r.cls).toBeLessThan(0.1);
    expect(r.inp).toBeLessThan(200);
    await context.close();
  }
  console.log(`plan vitals (4x CPU, 150 ms RTT, 1.6 Mbit/s): ${out.join("; ")}`);
});
