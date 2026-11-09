import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

// Walking skeleton (M1-08), in a browser. Targets the deployed container when E2E_BASE_URL is set
// (BL-01 6625891576), otherwise the local production build. Needs the seeded owner and judge logins
// (E2E_OWNER_PASSWORD / SEED_OWNER_PASSWORD, E2E_JUDGE_PASSWORD / SEED_JUDGE_PASSWORD) and, for the
// live-status test, a real sandbox (the owner creates a real sandbox transfer). Without credentials
// the tests are skipped loudly; nothing here stubs the product path.
const ownerPassword = process.env.E2E_OWNER_PASSWORD ?? process.env.SEED_OWNER_PASSWORD;
const judgePassword = process.env.E2E_JUDGE_PASSWORD ?? process.env.SEED_JUDGE_PASSWORD;
const ownerEmail = process.env.E2E_OWNER_EMAIL ?? "owner@carnet.example";

test.skip(
  !ownerPassword,
  "E2E_OWNER_PASSWORD (or SEED_OWNER_PASSWORD) is not set; skeleton e2e skipped.",
);

// Evidence screenshots (M1-08): written only when E2E_EVIDENCE_DIR is set, so normal runs leave no files.
const evidenceDir = process.env.E2E_EVIDENCE_DIR;
async function shot(page: Page, name: string): Promise<void> {
  if (!evidenceDir) return;
  await page.screenshot({ path: resolve(evidenceDir, `${name}.png`), fullPage: true });
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  const res = await page.request.post("/api/auth/sign-in/email", { data: { email, password } });
  expect(res.status()).toBe(200);
}

test("the owner creates a payment and the UI shows each new status within 6 s, announced", async ({
  page,
}) => {
  test.skip(
    !process.env.E2E_BASE_URL && !process.env.AIRWALLEX_CLIENT_ID,
    "creates a real sandbox transfer: set E2E_BASE_URL (deployed) or run the stack with AIRWALLEX_* keys; skipped locally without them.",
  );
  test.setTimeout(240_000);
  await signIn(page, ownerEmail, ownerPassword ?? "");
  await page.goto("/payments");
  await expect(page.getByRole("heading", { level: 1, name: "Sandbox payments" })).toBeVisible();

  const reference = `E2E skeleton ${Date.now()}`;
  await page.getByLabel("Reference").fill(reference);
  await page.getByRole("button", { name: "Create payment" }).click();
  // M2-03: the payment is saved, not sent. With no documents its evidence is missing, so the owner
  // acknowledges the reasons and sends from the evidence view; then the payment page shows the transfer.
  await expect(page).toHaveURL(/\/payments\/[0-9a-f-]{36}\/evidence$/, { timeout: 30_000 });
  const id = page.url().split("/").slice(-2)[0] ?? "";
  await page.getByLabel(/I have read the reasons above/).check();
  await page.getByRole("button", { name: "Acknowledge and send" }).click();
  await expect(page.getByText("This payment has been sent")).toBeVisible({ timeout: 30_000 });
  await page.goto(`/payments/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: reference })).toBeVisible();

  // The worker creates the real sandbox transfer; the page polls every 3 s and the transfer id appears.
  await expect(page.getByText(/^[0-9a-f]{8}-[0-9a-f]{4}-/).first()).toBeVisible({
    timeout: 90_000,
  });
  const status = page.getByTestId("payment-status");
  await expect(status).toContainText(/Scheduled|Processing/, { timeout: 90_000 });
  await expect(status).toContainText("Processing", { timeout: 90_000 });
  await shot(page, "1-owner-payment-processing");

  // Ask the sandbox for SENT. Measure from the stored change (server `transfer_updated_at`) to the UI.
  await page.getByRole("button", { name: "Simulate sent" }).click();
  await expect(page.locator("#live-region")).toContainText("Airwallex reports", {
    timeout: 60_000,
  });
  const stored = await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/v1/payments/${id}`);
        const body = (await res.json()) as { payment: { transfer_status: string } };
        return body.payment.transfer_status;
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toBe("SENT")
    .then(() => Date.now());
  await expect(status).toContainText("Sent, not yet paid", { timeout: 6_000 });
  const lag = Date.now() - stored;
  test.info().annotations.push({ type: "ui-lag-ms", description: String(lag) });
  expect(lag).toBeLessThan(6_000);
  await expect(page.locator("#live-region")).toContainText("Sent, not yet paid");
  await shot(page, "2-owner-payment-sent");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    results.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
  ).toEqual([]);

  await page.goto("/payments");
  await expect(page.getByRole("heading", { level: 1, name: "Sandbox payments" })).toBeVisible();
  await shot(page, "3-owner-payments-list");
});

test("the viewer (judge) sees the list and has no create form", async ({ page }) => {
  test.skip(!judgePassword, "E2E_JUDGE_PASSWORD (or SEED_JUDGE_PASSWORD) is not set.");
  await signIn(page, "judge@carnet.example", judgePassword ?? "");
  await page.goto("/payments");
  await expect(page.getByText("Only the owner can create one.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create payment" })).toHaveCount(0);
  await shot(page, "4-viewer-payments-list");
  const denied = await page.request.post("/api/v1/payments", {
    headers: { "idempotency-key": "e2e-viewer-denied-0001" },
    data: { amount: { amount: "1.00", currency: "USD" }, reference: "viewer" },
  });
  expect(denied.status()).toBe(403);
});
