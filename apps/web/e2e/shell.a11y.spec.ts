import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// WCAG 2.2 AA through axe on the shell's pages, in both colour schemes. Zero serious or critical
// violations is the bar (M1-07); minor and moderate ones are printed so a reviewer can see them.
const pages = [
  { name: "login", path: "/login" },
  { name: "shell home", path: "/" },
  { name: "queue (empty state)", path: "/queue" },
  { name: "plan (empty state)", path: "/plan" },
  { name: "ops (empty state)", path: "/ops" },
  { name: "not found", path: "/does-not-exist" },
] as const;

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

for (const scheme of ["light", "dark"] as const) {
  test.describe(`axe, ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    for (const { name, path } of pages) {
      test(`${name} (${path}) has no serious or critical violations`, async ({ page }, info) => {
        await page.goto(path);
        await expect(page.locator("main")).toBeVisible();
        const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        await info.attach(`axe-${scheme}-${name}.json`, {
          body: JSON.stringify(results, null, 2),
          contentType: "application/json",
        });
        for (const v of results.violations) {
          console.log(
            `[${scheme}] ${path} ${v.impact ?? "unknown"} ${v.id}: ${v.nodes.length} node(s)`,
          );
        }
        const blocking = results.violations.filter(
          (v) => v.impact === "serious" || v.impact === "critical",
        );
        expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
      });
    }
  });
}

test("the skip link is the first tab stop and moves focus to main", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
});

test("the nav marks the current page", async ({ page }) => {
  await page.goto("/plan");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Plan" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Queue" })).not.toHaveAttribute(
    "aria-current",
    "page",
  );
});
