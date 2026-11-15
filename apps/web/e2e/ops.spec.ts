import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// /ops (M1-09): read-only for the viewer (judge) in replay (M4-05), 200 for owner and approver, no client-side errors,
// "No data yet" on an empty database, and axe clean in both schemes. Needs the web server started
// with DATABASE_URL and BETTER_AUTH_* and the demo users seeded with the SEED_* passwords
// (`npx tsx packages/db/src/seed/run.ts`); without the passwords the tests are skipped loudly.
const passwords = {
  owner: process.env.SEED_OWNER_PASSWORD,
  approver: process.env.SEED_APPROVER_PASSWORD,
  viewer: process.env.SEED_JUDGE_PASSWORD,
};
const emails = {
  owner: "owner@carnet.example",
  approver: "approver@carnet.example",
  viewer: "judge@carnet.example",
} as const;

test.skip(
  !passwords.owner || !passwords.approver || !passwords.viewer,
  "SEED_OWNER_PASSWORD, SEED_APPROVER_PASSWORD and SEED_JUDGE_PASSWORD are not set; /ops e2e skipped.",
);

async function signIn(page: Page, role: keyof typeof emails): Promise<void> {
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: emails[role], password: passwords[role] },
  });
  expect(res.status(), await res.text()).toBe(200);
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  return errors;
}

test("no session: /ops redirects to /login", async ({ page }) => {
  await page.goto("/ops");
  await expect(page).toHaveURL(/\/login$/);
});

// M4-05: the judge reads /ops of the recording, read-only, under the recording banner.
test("viewer (judge): /ops answers 200 read-only under the recording banner", async ({ page }) => {
  await signIn(page, "viewer");
  const res = await page.goto("/ops");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("region", { name: "Recording notice" })).toBeVisible();
  await expect(page.locator('[data-testid$="-button"]')).toHaveCount(0);
});

for (const role of ["owner", "approver"] as const) {
  test(`${role}: /ops answers 200 and renders without client errors`, async ({ page }) => {
    const errors = trackErrors(page);
    await signIn(page, role);
    const res = await page.goto("/ops");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Ops" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Service levels" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(errors).toEqual([]);
  });
}

test("owner, empty database: the webhook ack card says no data with 0 samples", async ({
  page,
}) => {
  await signIn(page, "owner");
  await page.goto("/ops");
  const card = page.getByRole("article", { name: "Webhook acknowledged, p95" });
  await expect(card).toContainText("No data yet");
  await expect(card).toContainText("0 samples");
  await expect(card).not.toContainText("Meets target");
});

for (const scheme of ["light", "dark"] as const) {
  test(`owner: /ops has no serious or critical axe violations (${scheme})`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    await signIn(page, "owner");
    await page.goto("/ops");
    await expect(page.locator("main")).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    await info.attach(`axe-${scheme}-ops.json`, {
      body: JSON.stringify(results, null, 2),
      contentType: "application/json",
    });
    const blocking = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
}
