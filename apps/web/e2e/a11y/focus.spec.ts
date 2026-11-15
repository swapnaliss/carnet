import { expect, test } from "@playwright/test";
import { hasStack, SKIP_REASON, type SeededRfi, seedHold, seedHoldWorld, signIn } from "./support";

// Focus management (M4-07 Scope 3): dialogs return focus to their trigger, a confirmed approval moves
// focus to the status message, a 3 s poll update never moves focus and is announced through the shell's
// polite live region; plus one h1 per page, landmarks and the skip link on the hold screen.
test.skip(!hasStack, SKIP_REASON);
test.describe.configure({ mode: "serial" });

let rfis: Record<string, SeededRfi> = {};
test.beforeAll(() => {
  test.setTimeout(240_000);
  rfis = seedHoldWorld();
});

test("the approve dialog takes focus on its title and returns it to the trigger on Escape and Cancel", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/rfis/${rfis["draft-ready"]?.id}`);
  const trigger = page.getByTestId("approve-button");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByTestId("approve-dialog");
  await expect(dialog.getByRole("heading", { name: "Approve and submit" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("after a confirmed approval, focus is on the approval status message", async ({ page }) => {
  await signIn(page);
  await page.goto(`/rfis/${rfis.approve?.id}`);
  await page.getByTestId("approve-button").focus();
  await page.keyboard.press("Enter");
  await page
    .getByTestId("approve-dialog")
    .getByRole("button", { name: /Approve and submit \d+ answers/ })
    .focus();
  await page.keyboard.press("Enter");
  const status = page.getByTestId("approval-status");
  await expect(status).toContainText("Approved by you");
  await expect(status).toBeFocused();
  await expect(status).toHaveAttribute("role", "status");
});

test("a poll update does not move focus and is announced politely", async ({ page }) => {
  await signIn(page);
  await page.goto(`/rfis/${rfis.poll?.id}`);
  await expect(page.getByTestId("hold-drafting")).toBeVisible();
  // The person is reading: focus on the back link at the top of the hold screen.
  const back = page.getByRole("main").getByRole("link").first();
  await back.focus();
  const before = await back.evaluate((el) => el.outerHTML);
  seedHold("advance", rfis.poll?.id ?? "");
  await expect(page.getByTestId("question-status").first()).toHaveText("Ready", {
    timeout: 15_000,
  });
  const live = page.locator("#live-region");
  await expect(live).toContainText("Drafts are ready");
  await expect(live).toHaveAttribute("aria-live", "polite");
  await expect(back).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.outerHTML)).toBe(before);
});

test("errors from an action the person started are assertive", async ({ page }) => {
  await signIn(page);
  await page.goto(`/rfis/${rfis.edit?.id}`);
  await page.route("**/api/v1/rfis/*/approvals", (r) =>
    r.request().method() === "POST" ? r.fulfill({ status: 500, body: "{}" }) : r.continue(),
  );
  const dialog = page.getByTestId("approve-dialog");
  await expect(async () => {
    await page.getByTestId("approve-button").focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await dialog.getByRole("button", { name: /Approve and submit \d+ answers/ }).focus();
  await page.keyboard.press("Enter");
  const alert = page.getByRole("alert").first();
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute("role", "alert");
});

for (const name of ["draft-ready", "needs-owner-view", "answered"] as const) {
  test(`hold screen (${name}): one h1, landmarks, skip link to main`, async ({ page }) => {
    await signIn(page);
    await page.goto(`/rfis/${rfis[name]?.id}`);
    await expect(page.getByTestId("hold-screen")).toBeVisible();
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("banner")).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "Main" })).toBeAttached();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
  });
}
