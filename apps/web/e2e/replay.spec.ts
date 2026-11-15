import { expect, type Page, test } from "@playwright/test";

// M4-05: the judge walks the recorded run. Needs a web server on a database where
// `npm run demo:reset -- --yes` has run (it loads fixtures/replay/*), and SEED_JUDGE_PASSWORD (plus
// SEED_OWNER_PASSWORD for the live-switch test). Without them the tests are skipped loudly.
//
// Asserts: the recording banner on every replay route (and in the page title, and in the payee view);
// the timeline controls (play, pause, next, previous, restart) by keyboard; a network spy that sees
// zero requests to Airwallex hosts and zero model API requests during the replay; the judge cannot
// switch to live; the owner can, and the LIVE indicator replaces the banner.
const judge = process.env.SEED_JUDGE_PASSWORD;
const owner = process.env.SEED_OWNER_PASSWORD;
test.skip(!judge, "SEED_JUDGE_PASSWORD is not set; the replay e2e is skipped.");
test.describe.configure({ mode: "serial" });

const BANNER = /Recording of a real sandbox run on .+\. Nothing here is live\./;
const FORBIDDEN_HOSTS = /airwallex\.com|anthropic\.com/;

async function signIn(page: Page, email: string, password: string): Promise<void> {
  const res = await page.request.post("/api/auth/sign-in/email", { data: { email, password } });
  expect(res.status(), await res.text()).toBe(200);
}

function spy(page: Page): string[] {
  const hits: string[] = [];
  page.on("request", (r) => {
    if (FORBIDDEN_HOSTS.test(new URL(r.url()).hostname)) hits.push(r.url());
  });
  return hits;
}

async function expectBanner(page: Page): Promise<void> {
  const banner = page.getByRole("region", { name: "Recording notice" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(BANNER);
  await expect(page).toHaveTitle(/Recording/);
}

test("the judge walks the recording: banner on every screen, no Airwallex or model request", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const hits = spy(page);
  await signIn(page, "judge@carnet.example", judge as string);

  await page.goto("/replay");
  await expectBanner(page);
  const timeline = page.locator("[data-recording]").first();
  await expect(timeline.getByTestId("captured-on")).not.toHaveText("Not recorded");
  await expect(timeline.getByTestId("deployed-version")).not.toHaveText("Not recorded");
  await expect(timeline.getByTestId("models")).toContainText("claude-");

  // Keyboard: next, previous, play, pause, restart.
  const current = timeline.getByTestId("replay-current");
  await expect(current).toContainText("Step 1 of");
  await timeline.getByTestId("replay-next").focus();
  await page.keyboard.press("Enter");
  await expect(current).toContainText("Step 2 of");
  await timeline.getByTestId("replay-previous").focus();
  await page.keyboard.press("Enter");
  await expect(current).toContainText("Step 1 of");
  await timeline.getByTestId("replay-play").focus();
  await page.keyboard.press("Enter");
  await expect(current).toContainText("Step 2 of", { timeout: 6_000 });
  await timeline.getByTestId("replay-pause").click();
  await timeline.getByTestId("replay-restart").click();
  await expect(current).toContainText("Step 1 of");

  // Every screen the storyboard links to (steps 1-8), the payee page and /ops.
  const hrefs = new Set<string>();
  const list = timeline.getByTestId("replay-list").getByRole("button");
  const n = await list.count();
  for (let i = 0; i < n; i++) {
    await list.nth(i).click();
    const link = timeline.getByTestId("replay-open-screen");
    if (await link.count()) hrefs.add((await link.getAttribute("href")) as string);
  }
  for (const route of ["/queue", "/rfis", "/plans/current", "/ops", "/payments"]) hrefs.add(route);
  expect([...hrefs].some((h) => h.startsWith("/rfis/"))).toBe(true);
  expect([...hrefs].some((h) => /^\/payments\/[^/]+\/evidence$/.test(h))).toBe(true);
  for (const href of hrefs) {
    const res = await page.goto(href);
    expect(res?.status(), href).toBeLessThan(400);
    await expectBanner(page);
  }

  const payee = await page.goto("/replay/payee");
  expect(payee?.status()).toBe(200);
  await expect(page.getByRole("region", { name: "Recording notice" })).toContainText(BANNER);
  await expect(page).toHaveTitle(/Recording/);

  expect(hits, "requests to Airwallex or the model API during the replay").toEqual([]);
});

test("the judge cannot switch to live, by the API or by tampering", async ({ page }) => {
  await signIn(page, "judge@carnet.example", judge as string);
  const put = await page.request.put("/api/v1/session/mode?mode=live", {
    data: { mode: "live" },
    headers: { "x-carnet-mode": "live" },
  });
  expect(put.status()).toBe(403);
  await page.goto("/queue?mode=live");
  await expectBanner(page);
  await expect(page.getByTestId("live-indicator")).toHaveCount(0);
  await expect(page.getByTestId("switch-mode-live")).toHaveCount(0);
});

test("the owner switches to the recording and back; LIVE replaces the banner", async ({ page }) => {
  test.skip(!owner, "SEED_OWNER_PASSWORD is not set.");
  await signIn(page, "owner@carnet.example", owner as string);
  await page.goto("/queue");
  await expect(page.getByTestId("live-indicator")).toBeVisible();
  await page.getByTestId("switch-mode-replay").click();
  await expectBanner(page);
  await expect(page.getByTestId("live-indicator")).toHaveCount(0);
  await page.getByTestId("switch-mode-live").click();
  await expect(page.getByTestId("live-indicator")).toBeVisible();
  await expect(page.getByRole("region", { name: "Recording notice" })).toHaveCount(0);
});
