import { expect, type Page, test } from "@playwright/test";
import { hasStack, type SeededRfi, SKIP_REASON, seedHoldWorld, signIn } from "./support";

// INP on mid-tier phones (M4-07 follow-up): the approve dialog and the answer editor are not part of the
// hold screen's first-load JavaScript; each loads when it is first opened (next/dynamic), and both still
// work by keyboard. The markers are strings only those two modules contain (a test id, the drafts endpoint path).
test.skip(!hasStack, SKIP_REASON);

let rfis: Record<string, SeededRfi> = {};
test.beforeAll(() => {
  test.setTimeout(240_000);
  rfis = seedHoldWorld();
});

function scripts(page: Page): string[] {
  const bodies: string[] = [];
  page.on("response", async (res) => {
    if (res.request().resourceType() !== "script") return;
    try {
      bodies.push(await res.text());
    } catch {
      // a navigation can cancel a body read; the assertion below only needs the ones that arrived
    }
  });
  return bodies;
}
const has = (bodies: string[], marker: string) => bodies.some((b) => b.includes(marker));

test("the approve dialog and the answer editor load on first use, not with the page", async ({
  page,
}) => {
  const bodies = scripts(page);
  await signIn(page);
  await page.goto(`/rfis/${rfis["draft-ready"]?.id}`);
  await expect(page.getByTestId("hold-screen")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(has(bodies, "dialog-answer-text"), "dialog code in first load").toBe(false);
  expect(has(bodies, "/drafts"), "editor code in first load").toBe(false);

  await expect(async () => {
    await page.getByTestId("approve-button").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("approve-dialog")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await expect(page.getByRole("heading", { name: "Approve and submit" })).toBeFocused();
  await expect.poll(() => has(bodies, "dialog-answer-text")).toBe(true);
  await page.keyboard.press("Escape");

  const first = page.getByTestId("question").first();
  await first.getByRole("button", { name: "Edit answer" }).focus();
  await page.keyboard.press("Enter");
  await expect(first.getByRole("textbox", { name: "Answer text" })).toBeVisible();
  await expect.poll(() => has(bodies, "/drafts")).toBe(true);
});
