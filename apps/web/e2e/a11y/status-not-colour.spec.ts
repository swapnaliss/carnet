import { expect, type Page, test } from "@playwright/test";
import { hasStack, type SeededRfi, SKIP_REASON, seedHoldWorld, signIn } from "./support";

// WCAG 1.4.1 (M4-07 Scope 4): status is never conveyed by colour alone. Every status component on the
// queue and the hold screen (StatusBadge, EvidenceStrength, the Held badge, the hold-screen badges)
// carries a text label and a decorative icon; HELD FOR INFORMATION is checked by name.
test.skip(!hasStack, SKIP_REASON);

let rfis: Record<string, SeededRfi> = {};
test.beforeAll(() => {
  test.setTimeout(240_000);
  rfis = seedHoldWorld();
});

async function badges(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((els) =>
    els.map((el) => ({
      text: (el.textContent ?? "").trim(),
      icon: el.querySelector("svg[aria-hidden='true']") !== null,
      html: el.outerHTML.slice(0, 120),
    })),
  );
}

test("queue: every status, evidence and held badge has a text label and an icon", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/queue");
  await expect(page.getByTestId("queue-table")).toBeVisible();
  const table = page.getByTestId("queue-table");
  const found = await badges(
    page,
    "[data-testid=queue-table] [data-status], [data-testid=queue-table] [data-flag]",
  );
  expect(found.length).toBeGreaterThan(3);
  for (const b of found) {
    expect(b.text, b.html).not.toBe("");
    expect(b.icon, b.html).toBe(true);
  }
  const held = table.getByText("Held for information", { exact: true }).first();
  await expect(held).toBeVisible();
  expect(await held.evaluate((el) => !!el.querySelector("svg[aria-hidden='true']"))).toBe(true);
});

test("hold screen: the held and transfer badges have text and an icon", async ({ page }) => {
  await signIn(page);
  await page.goto(`/rfis/${rfis["draft-ready"]?.id}`);
  const area = page.getByTestId("hold-badges");
  await expect(area).toContainText("Held for information");
  const found = await badges(page, "[data-testid=hold-badges] > *");
  expect(found.length).toBeGreaterThan(0);
  for (const b of found) {
    expect(b.text, b.html).not.toBe("");
    expect(b.icon, b.html).toBe(true);
  }
  const statuses = await badges(page, "[data-testid=question-status]");
  for (const s of statuses) expect(s.text, s.html).not.toBe("");
});
