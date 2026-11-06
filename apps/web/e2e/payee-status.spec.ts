import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import pg from "pg";

// Payee status links (M3-06), end to end on the production build.
// Part 1 needs nothing but the server: the public route's headers and uniform 404.
// Part 2 needs the web server started with DATABASE_URL and BETTER_AUTH_* and the demo users seeded
// (`npx tsx packages/db/src/seed/run.ts` with the SEED_* passwords); without them it is skipped loudly.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const passwords = {
  owner: process.env.SEED_OWNER_PASSWORD,
  judge: process.env.SEED_JUDGE_PASSWORD,
};
const databaseUrl = process.env.DATABASE_URL;
const REFERENCE = "E2E-PAYEE-REF-4417";

test.describe("public route, any server", () => {
  test("an unknown token: 404 on GET and HEAD with the privacy headers", async ({ request }) => {
    const token = "A".repeat(43);
    for (const res of [
      await request.get(`/status/${token}`),
      await request.head(`/status/${token}`),
    ]) {
      // 404 with a database; 503 (same headers) if the server has none.
      expect([404, 503]).toContain(res.status());
      const h = res.headers();
      expect(h["referrer-policy"]).toBe("no-referrer");
      expect(h["x-robots-tag"]).toContain("noindex");
      expect(h["cache-control"]).toBe("no-store");
      expect(h["x-content-type-options"]).toBe("nosniff");
      expect(h["set-cookie"]).toBeUndefined();
    }
  });
});

test.describe("owner and payee flow", () => {
  test.skip(
    !passwords.owner || !passwords.judge || !databaseUrl,
    "SEED_* passwords and DATABASE_URL are not set; the owner flow is skipped.",
  );

  // A fresh payment per test, so each starts with no links.
  async function newPayment(): Promise<string> {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const biz = await client.query<{ id: string }>("select id from businesses limit 1");
      const businessId = biz.rows[0]?.id;
      const res = await client.query<{ id: string }>(
        `insert into payments (business_id, amount_minor, currency, source_currency, method, reference,
           transfer_id, transfer_status, transfer_updated_at)
         values ($1, 720000, 'EUR', 'USD', 'SWIFT', $2, $3, 'PROCESSING', now())
         returning id`,
        [businessId, REFERENCE, `tr_e2e_${Date.now()}`],
      );
      return res.rows[0]?.id ?? "";
    } finally {
      await client.end();
    }
  }

  async function signIn(page: Page, role: "owner" | "judge") {
    const email = role === "owner" ? "owner@carnet.example" : "judge@carnet.example";
    const res = await page.request.post("/api/auth/sign-in/email", {
      data: { email, password: passwords[role] },
    });
    expect(res.status(), await res.text()).toBe(200);
  }

  async function axe(page: Page, name: string, info: import("@playwright/test").TestInfo) {
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    await info.attach(`axe-${name}.json`, {
      body: JSON.stringify(results, null, 2),
      contentType: "application/json",
    });
    const blocking = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }

  for (const scheme of ["light", "dark"] as const) {
    test(`create with the keyboard, open as the payee, revoke (${scheme})`, async ({
      page,
      browser,
    }, info) => {
      const paymentId = await newPayment();
      await page.emulateMedia({ colorScheme: scheme });
      await signIn(page, "owner");
      await page.goto(`/payments/${paymentId}`);
      await expect(page.getByRole("heading", { level: 1, name: "Payment" })).toBeVisible();
      await expect(page.getByText("No status links yet")).toBeVisible();
      await axe(page, `owner-empty-${scheme}`, info);

      // Keyboard: move to the opt-in radio with the arrow keys, then submit with Enter.
      await page.getByRole("radio", { name: /Standard status/ }).focus();
      await page.keyboard.press("ArrowDown");
      await expect(page.getByRole("radio", { name: /Say when it is delayed/ })).toBeChecked();
      await page.getByRole("radio", { name: /Standard status/ }).check();
      await page.getByRole("button", { name: "Create status link" }).focus();
      await page.keyboard.press("Enter");

      const address = page.getByLabel("Link address");
      await expect(address).toBeVisible();
      const url = await address.inputValue();
      expect(url).toMatch(/\/status\/[A-Za-z0-9_-]{43}$/);
      await expect(page.getByText("Active").first()).toBeVisible();
      await axe(page, `owner-created-${scheme}`, info);

      // The payee: a fresh context, no cookies.
      const payeeContext = await browser.newContext({ colorScheme: scheme });
      const payee = await payeeContext.newPage();
      const res = await payee.goto(url);
      expect(res?.status()).toBe(200);
      const h = res?.headers() ?? {};
      expect(h["referrer-policy"]).toBe("no-referrer");
      expect(h["x-robots-tag"]).toContain("noindex");
      expect(h["cache-control"]).toBe("no-store");
      await expect(payee.getByRole("heading", { level: 1, name: "Payment status" })).toBeVisible();
      await expect(payee.getByText("Processing", { exact: true })).toBeVisible();
      const text = await payee.locator("body").innerText();
      for (const secret of [REFERENCE, "EUR", "7,200", "7200", "Carnet"]) {
        expect(text, secret).not.toContain(secret);
      }
      expect(await payeeContext.cookies()).toEqual([]);
      await axe(payee, `payee-${scheme}`, info);

      // Revoke from the owner page; the payee link then answers the generic 404.
      await page.getByRole("button", { name: /^Revoke link created/ }).click();
      await expect(page.getByText("Revoked").first()).toBeVisible();
      const gone = await payee.goto(url);
      expect(gone?.status()).toBe(404);
      await expect(
        payee.getByRole("heading", { level: 1, name: "This link is not available" }),
      ).toBeVisible();
      await axe(payee, `payee-404-${scheme}`, info);
      await payeeContext.close();
    });
  }

  test("a viewer sees the panel read-only", async ({ page }, info) => {
    const paymentId = await newPayment();
    await signIn(page, "judge");
    await page.goto(`/payments/${paymentId}`);
    await expect(
      page.getByText("This login is read-only, so it cannot create or revoke links."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Create status link" })).toHaveCount(0);
    await axe(page, "viewer", info);
  });
});
