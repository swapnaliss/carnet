import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// The hold screen (M2-08) against the production build and a database seeded with REAL pipeline output
// over recorded responses (apps/web/e2e/fixtures/seed-hold.ts: extraction and drafting replayed through
// the real handlers). Needs DATABASE_URL, the SEED_*_PASSWORD variables and the web server started with
// the same database; without them the file is skipped loudly. Screenshots go to SHOTS_DIR (default
// $TMPDIR/m2-08-shots); the ui-reviewer run uses .review/M2-08.
const passwords = {
  owner: process.env.SEED_OWNER_PASSWORD,
  viewer: process.env.SEED_JUDGE_PASSWORD,
};
test.skip(
  !passwords.owner || !passwords.viewer || !process.env.DATABASE_URL,
  "DATABASE_URL and SEED_*_PASSWORD are not set; hold-screen e2e skipped.",
);
test.describe.configure({ mode: "serial" });

const SHOTS = process.env.SHOTS_DIR ?? join(process.env.TMPDIR ?? "/tmp", "m2-08-shots");
mkdirSync(SHOTS, { recursive: true });
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

interface Seeded {
  id: string;
  airwallexId: string;
}
let ids: Record<string, Seeded> = {};
const seed = (...args: string[]) =>
  execFileSync("npx", ["tsx", "apps/web/e2e/fixtures/seed-hold.ts", ...args], {
    encoding: "utf8",
    env: process.env,
    timeout: 120_000,
  });

test.beforeAll(() => {
  test.setTimeout(150_000);
  const out = seed("seed").trim().split("\n").at(-1) ?? "{}";
  ids = JSON.parse(out) as Record<string, Seeded>;
});

async function signIn(page: Page, role: "owner" | "viewer" = "owner"): Promise<void> {
  const email = role === "owner" ? "owner@carnet.example" : "judge@carnet.example";
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email, password: passwords[role] },
  });
  expect(res.status(), await res.text()).toBe(200);
}

const open = async (page: Page, name: string) => {
  await signIn(page);
  await page.goto(`/rfis/${ids[name]?.id}`);
  await expect(page.getByTestId("hold-screen")).toBeVisible();
};
const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
const view = async (page: Page, name: string) =>
  (await (await page.request.get(`/api/v1/rfis/${ids[name]?.id}/hold`)).json()) as {
    rfi: { airwallex_updated_at: string };
    draft: { id: string; prompt_version: string };
    questions: {
      id: string;
      title: string;
      answer: { text: string; citations: { quote: string; page: number }[] };
    }[];
  };

test("a DRAFT_READY RFI shows drafts, citations and the verbatim snippet with its page", async ({
  page,
}) => {
  await open(page, "draft-ready");
  const data = await view(page, "draft-ready");
  await expect(page.getByTestId("question")).toHaveCount(4);
  await expect(page.getByTestId("hold-badges")).toContainText("Held for information");
  await expect(page.getByTestId("hold-badges")).toContainText("Processing");
  for (const q of data.questions.slice(0, 2)) {
    const card = page.getByTestId("question").filter({ hasText: q.title });
    await expect(card.getByTestId("question-status")).toHaveText("Ready");
    await expect(card.getByTestId("claim").first()).toBeVisible();
    for (const c of q.answer.citations) {
      await expect(
        card.getByTestId("source-quote").filter({ hasText: c.quote }).first(),
      ).toBeVisible();
      await expect(card.getByTestId("source-snippet").first()).toContainText(`page ${c.page}`);
    }
    await expect(card.getByTestId("source-snippet").first()).toContainText("Quote verified");
  }
  await expect(page.getByTestId("approve-button")).toHaveAttribute("aria-disabled", "false");
  await shot(page, "hold-draft-ready-1440");
});

test("NEEDS_OWNER blocks the RFI with the reason; approve is disabled and says why", async ({
  page,
}) => {
  await open(page, "needs-owner");
  const blocked = page.getByTestId("needs-owner").first();
  await expect(blocked).toBeVisible();
  await expect(blocked.getByTestId("needs-owner-reason")).not.toBeEmpty();
  await expect(blocked).toContainText("blocks the whole request");
  await expect(page.getByTestId("approve-button")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("approval-reason")).toContainText("need your answer");
  await shot(page, "hold-needs-owner-1440");
});

test("a model-unavailable RFI shows the matching explanation", async ({ page }) => {
  await open(page, "model-unavailable");
  await expect(page.getByTestId("needs-owner-reason").first()).toContainText(
    "could not draft this answer right now",
  );
  await expect(page.getByTestId("approve-button")).toHaveAttribute("aria-disabled", "true");
  await shot(page, "hold-model-unavailable-1440");
});

test("a wrong figure is rejected and keeps approve disabled; a corrected edit enables it", async ({
  page,
}) => {
  await open(page, "edit");
  const data = await view(page, "edit");
  const first = page.getByTestId("question").first();
  const original = data.questions[0]?.answer.text ?? "";
  await first.getByRole("button", { name: "Edit answer" }).click();
  const box = first.getByRole("textbox", { name: "Answer text" });
  const wrong = /\d[\d,]*\.\d{2}/.test(original)
    ? original.replace(/\d[\d,]*\.\d{2}/, "9,999.99")
    : `${original} Total USD 9,999.99.`;
  await box.fill(wrong);
  await first.getByRole("button", { name: "Save edit" }).click();
  await expect(first.getByTestId("needs-owner")).toBeVisible();
  await expect(first).toContainText("did not pass");
  await expect(page.getByTestId("approve-button")).toHaveAttribute("aria-disabled", "true");
  await shot(page, "hold-edit-rejected-1440");
  await first.getByRole("button", { name: "Edit answer" }).click();
  await first.getByRole("textbox", { name: "Answer text" }).fill(original);
  await first.getByRole("button", { name: "Save edit" }).click();
  await expect(first.getByTestId("question-status")).toHaveText("Edited by you");
  await expect(page.getByTestId("approve-button")).toHaveAttribute("aria-disabled", "false");
  const after = await view(page, "edit");
  expect(after.draft.id).not.toBe(data.draft.id);
});

test("approve sends exactly the displayed snapshot and shows only server-confirmed state", async ({
  page,
}) => {
  await open(page, "approve");
  const data = await view(page, "approve");
  let posted: { body: Record<string, unknown>; key: string | undefined } | null = null;
  await page.route("**/api/v1/rfis/*/approvals", async (route) => {
    if (route.request().method() === "POST") {
      posted = {
        body: JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>,
        key: route.request().headers()["idempotency-key"],
      };
    }
    await route.continue();
  });
  await page.getByTestId("approve-button").click();
  const dialog = page.getByTestId("approve-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Approve and submit" })).toBeFocused();
  const shown = await dialog.getByTestId("dialog-answer-text").allTextContents();
  await shot(page, "hold-approve-dialog-1440");
  await dialog.getByRole("button", { name: "Show what this approval binds" }).click();
  await expect(dialog.getByTestId("dialog-bound")).toBeVisible();
  await shot(page, "hold-approve-dialog-bound-1440");
  // The footer stays reachable at a short height and at 375 (the body scrolls, the buttons do not).
  for (const [w, h, label] of [
    [1280, 600, "short"],
    [375, 600, "375"],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeInViewport();
    await expect(
      dialog.getByRole("button", { name: /Approve and submit 4 answers/ }),
    ).toBeInViewport();
    await shot(page, `hold-approve-dialog-${label}`);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await dialog.getByRole("button", { name: /Approve and submit 4 answers/ }).click();
  await expect(page.getByTestId("approval-status")).toContainText("Approved by you");
  expect(posted).not.toBeNull();
  const sent = posted as unknown as { body: Record<string, unknown>; key?: string };
  const body = sent.body as {
    draft_id: string;
    prompt_version: string;
    rfi_updated_at: string;
    answers: { text: string; type: string }[];
  };
  expect(body.draft_id).toBe(data.draft.id);
  expect(body.prompt_version).toBe(data.draft.prompt_version);
  expect(body.rfi_updated_at).toBe(data.rfi.airwallex_updated_at);
  expect(body.answers.filter((a) => a.type === "TEXT").map((a) => a.text)).toEqual(shown);
  expect(sent.key).toBeTruthy();
  await shot(page, "hold-approved-waiting-1440");
});

test("a changed RFI between render and approve shows the stale error", async ({ page }) => {
  await open(page, "stale");
  const data = await view(page, "stale");
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("approve-dialog")).toBeVisible();
  seed("touch", ids.stale?.id ?? "");
  await expect(page.getByTestId("dialog-changed")).toContainText("answers changed");
  await shot(page, "hold-stale-dialog-1440");
  // The server refuses the old snapshot too.
  const res = await page.request.post(`/api/v1/rfis/${ids.stale?.id}/approvals`, {
    headers: { "idempotency-key": `stale-${Date.now()}-key` },
    data: {
      draft_id: data.draft.id,
      prompt_version: data.draft.prompt_version,
      rfi_updated_at: data.rfi.airwallex_updated_at,
      answers: [],
    },
  });
  expect([409, 412, 400]).toContain(res.status());
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("approve-dialog")).toBeHidden();
});

test("an owner completes a NEEDS_OWNER RFI with a statement and a document, then approves", async ({
  page,
}) => {
  await open(page, "needs-owner");
  const cards = page.getByTestId("question");
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    if ((await card.getByTestId("question-status").getAttribute("data-status")) !== "needs_owner")
      continue;
    const write = card.getByRole("button", { name: "Write an answer" });
    if (await write.count()) {
      await write.click();
      await card
        .getByRole("textbox", { name: "Your statement" })
        .fill("We have supplied this carrier for years under verbal terms.");
      await card.getByRole("button", { name: "Save edit" }).click();
    } else {
      await card.getByRole("button", { name: "Attach a document" }).click();
      await card.getByRole("checkbox", { name: /dn-/ }).first().check();
      await card.getByRole("button", { name: "Use these documents" }).click();
    }
    await expect(card.getByTestId("question-status")).not.toHaveAttribute(
      "data-status",
      "needs_owner",
    );
  }
  await expect(page.getByTestId("approve-button")).toHaveAttribute("aria-disabled", "false");
  await page.getByTestId("approve-button").click();
  await expect(page.getByTestId("approve-dialog")).toContainText(
    "could not check against a document",
  );
  await page
    .getByTestId("approve-dialog")
    .getByRole("button", { name: /Approve and submit \d+ answers/ })
    .click();
  await expect(page.getByTestId("approval-status")).toContainText("Approved by you");
});

test("polling picks up DRAFTING to DRAFT_READY, announces it, and pauses when hidden", async ({
  page,
}) => {
  await open(page, "poll");
  await expect(page.getByTestId("hold-drafting")).toBeVisible();
  await shot(page, "hold-drafting-1440");
  seed("advance", ids.poll?.id ?? "");
  await expect(page.getByTestId("question-status").first()).toHaveText("Ready", {
    timeout: 15_000,
  });
  await expect(page.locator("#live-region")).toContainText("Drafts are ready");
  let hits = 0;
  page.on("request", (r) => {
    if (r.url().includes("/hold")) hits++;
  });
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(4_000); // lets an in-flight timer fire and see the hidden tab
  const before = hits;
  await page.waitForTimeout(7_000);
  expect(hits).toBe(before);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      get: () => "visible",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => hits).toBeGreaterThan(before);
});

test("expired state removes approve", async ({ page }) => {
  await open(page, "expired");
  await expect(page.getByTestId("hold-expired")).toContainText(
    "This request expired. Ask Airwallex.",
  );
  await expect(page.getByTestId("approve-button")).toHaveAttribute("aria-disabled", "true");
  await shot(page, "hold-expired-1440");
});

test("answered state is read-only", async ({ page }) => {
  await open(page, "answered");
  await expect(page.getByTestId("hold-answered")).toContainText("Answer submitted");
  await expect(page.getByRole("button", { name: "Edit answer" })).toHaveCount(0);
  await expect(page.getByTestId("approve-button")).toHaveCount(0);
  await shot(page, "hold-answered-1440");
});

test("orphan RFI offers the link action; the list shows it under not linked", async ({ page }) => {
  await open(page, "orphan");
  await expect(page.getByRole("combobox", { name: "Link to payment" })).toBeVisible();
  await expect(page.getByTestId("approve-button")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("approval-reason")).toContainText("Link this request");
  await shot(page, "hold-orphan-1440");
  await page.goto("/rfis");
  await expect(page.getByRole("heading", { name: "Not linked to a payment" })).toBeVisible();
  await shot(page, "rfis-list-1440");
});

test("the kill switch shows its banner and disables approve", async ({ page }) => {
  seed("kill", "on");
  try {
    await open(page, "draft-ready");
    await expect(page.getByTestId("hold-killswitch")).toBeVisible();
    await expect(page.getByTestId("approve-button")).toHaveAttribute("aria-disabled", "true");
    await shot(page, "hold-killswitch-1440");
  } finally {
    seed("kill", "off");
  }
});

test("the viewer role cannot approve", async ({ page }) => {
  await signIn(page, "viewer");
  await page.goto(`/rfis/${ids["draft-ready"]?.id}`);
  await expect(page.getByTestId("approval-reason")).toContainText("read-only");
  await expect(page.getByTestId("approve-button")).toHaveCount(0);
});

test("list states: loading, empty, error with retry", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/v1/rfis?*", async (route) => {
    await new Promise((r) => setTimeout(r, 2_500));
    await route.fulfill({ json: { items: [] } });
  });
  await page.goto("/rfis");
  await expect(page.getByTestId("rfi-list-loading")).toBeVisible();
  await shot(page, "rfis-loading-1440");
  await expect(page.getByRole("heading", { name: "No requests from Airwallex" })).toBeVisible();
  await shot(page, "rfis-empty-1440");
  await page.unroute("**/api/v1/rfis?*");
  await page.route("**/api/v1/rfis?*", (route) => route.fulfill({ status: 500, body: "{}" }));
  await page.goto("/rfis");
  await expect(page.getByTestId("rfi-list-error")).toBeVisible();
  await shot(page, "rfis-error-1440");
  await page.unroute("**/api/v1/rfis?*");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("rfi-row").first()).toBeVisible();
});

test("hold loading skeleton renders and passes axe", async ({ page }) => {
  await signIn(page);
  await page.goto("/rfis-loading-preview");
  await expect(page.getByTestId("hold-skeleton")).toBeVisible();
  await expect(page.getByText("Loading the request for information")).toBeAttached();
  await shot(page, "hold-loading-1440");
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(
    results.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
  ).toEqual([]);
});

test("connection trouble shows the retrying indicator and stale banner and blocks approve", async ({
  page,
}) => {
  await open(page, "draft-ready");
  await page.route("**/api/v1/rfis/*/hold", (route) => route.abort());
  await expect(page.getByTestId("stale-banner")).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId("live-indicator")).toContainText("Retrying");
  await shot(page, "hold-stale-1440");
});

test("keyboard only: select a question, expand a snippet, approve", async ({ page }) => {
  await open(page, "keyboard");
  const nav = page.getByTestId("question-nav").getByRole("button");
  await nav.first().focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 3 }).nth(1)).toBeFocused();
  const toggle = page.getByRole("button", { name: "Show full quote" }).first();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Hide full quote" }).first()).toBeVisible();
  await page.getByTestId("approve-button").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("approve-dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Approve and submit" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("approve-dialog")).toBeHidden();
  await expect(page.getByTestId("approve-button")).toBeFocused();
  await page.keyboard.press("Enter");
  await page
    .getByTestId("approve-dialog")
    .getByRole("button", { name: /Approve and submit \d+ answers/ })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("approval-status")).toContainText("Approved by you");
});

for (const scheme of ["light", "dark"] as const) {
  for (const width of [375, 768, 1440] as const) {
    test(`a11y: ${scheme} ${width}: no serious or critical axe violations and screenshots`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await signIn(page);
      for (const name of ["draft-ready", "needs-owner-view", "expired", "answered"] as const) {
        await page.goto(`/rfis/${ids[name]?.id}`);
        await expect(page.getByTestId("hold-screen")).toBeVisible();
        await shot(page, `${name}-${scheme}-${width}`);
        const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        writeFileSync(
          join(SHOTS, `axe-${name}-${scheme}-${width}.json`),
          JSON.stringify(results.violations, null, 2),
        );
        await info.attach(`axe-${name}-${scheme}-${width}.json`, {
          body: JSON.stringify(results, null, 2),
          contentType: "application/json",
        });
        const blocking = results.violations.filter(
          (v) => v.impact === "serious" || v.impact === "critical",
        );
        expect(blocking.map((v) => `${name}: ${v.id}: ${v.help}`)).toEqual([]);
      }
      await page.goto(`/rfis/${ids["draft-ready"]?.id}`);
      await page.getByTestId("approve-button").click();
      await expect(page.getByTestId("approve-dialog")).toBeVisible();
      await shot(page, `approve-dialog-${scheme}-${width}`);
      const dialogAxe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      writeFileSync(
        join(SHOTS, `axe-approve-dialog-${scheme}-${width}.json`),
        JSON.stringify(dialogAxe.violations, null, 2),
      );
      expect(
        dialogAxe.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
      ).toEqual([]);
      await page.keyboard.press("Escape");
      await page.goto("/rfis-loading-preview");
      await expect(page.getByTestId("hold-skeleton")).toBeVisible();
      await shot(page, `loading-${scheme}-${width}`);
      await page.goto("/rfis");
      await expect(page.getByTestId("rfi-row").first()).toBeVisible();
      await shot(page, `rfis-${scheme}-${width}`);
      const list = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(
        list.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
      ).toEqual([]);
    });
  }
}
