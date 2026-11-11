import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  databaseUrl,
  judgePassword,
  newDraft,
  ownerPassword,
  signIn,
  storeScanFacts,
  uploadScan,
  withDb,
} from "./evidence-support";

// The payment queue and the evidence view (M2-03), end to end on the production build. Needs the web
// server started with DATABASE_URL and BETTER_AUTH_* and the demo users seeded (`npx tsx
// packages/db/src/seed/run.ts` with the SEED_* passwords); without them the tests are skipped loudly.
//
// The extraction worker is not part of this run (it calls a model). Where the worker would store the
// extracted facts of the uploaded scan, the test stores them itself, from the recorded real model
// response, as an image-only document produces them (not verified, needs confirmation).
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.skip(
  !ownerPassword || !judgePassword || !databaseUrl,
  "SEED_* passwords and DATABASE_URL are not set; the evidence e2e is skipped.",
);

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

test.describe("evidence view", () => {
  test("keyboard only: upload a scan, confirm its facts and reach acknowledge-and-send", async ({
    page,
  }, info) => {
    const paymentId = await newDraft();
    await signIn(page, "owner");
    await page.goto(`/payments/${paymentId}/evidence`);

    // Empty state first: nothing is linked, so the evidence is missing and the reason says so.
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Nordlicht Software GmbH");
    await expect(page.getByTestId("reasons")).toContainText(
      "No invoice is linked to this payment.",
    );
    await expect(
      page.getByRole("heading", { name: "No documents are linked to this payment" }),
    ).toBeVisible();
    await axe(page, "evidence-empty", info);

    // Upload with the keyboard (the file chooser is the browser's; the input is set, the rest is keys).
    const documentId = await uploadScan(page);
    await expect(page.getByText("Reading document")).toBeVisible();
    await expect(page.getByTestId("reasons")).toContainText("Carnet is still reading");

    // The worker would store the facts now; the page picks them up on its next poll (3 s while reading).
    await storeScanFacts(documentId);
    const facts = page.locator("[data-fact]");
    await expect(facts).toHaveCount(3, { timeout: 15_000 });
    // The source quote and its page sit beside each fact.
    const total = page.locator('[data-fact="total"]');
    await expect(total.getByTestId("fact-value")).toContainText("EUR 3,100.00");
    await expect(total.locator("blockquote")).toContainText("Page 1");
    await expect(total).toContainText("Needs your confirmation");
    await expect(page.getByTestId("reasons")).toContainText("not verified");
    await axe(page, "evidence-documents", info);

    // Confirm: tick each value (Space), then the button (Enter). It is disabled until all are ticked.
    const confirm = page.getByRole("button", { name: /^Confirm 3 facts$/ });
    await expect(confirm).toBeDisabled();
    const boxes = page.getByRole("checkbox", { name: /^Confirm / });
    await expect(boxes).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await boxes.nth(i).focus();
      await page.keyboard.press("Space");
    }
    await expect(confirm).toBeEnabled();
    await confirm.focus();
    await page.keyboard.press("Enter");
    await expect(total).toContainText("Confirmed by you", { timeout: 15_000 });

    // The payment still lacks its contract, so the evidence is not strong: the send panel asks for an
    // acknowledgement. Reach it by keyboard and use the checkbox; the button is the last stop.
    await expect(page.locator("[data-flag]").first()).toHaveAttribute("data-flag", "missing");
    await expect(page.getByTestId("reasons")).toContainText("no contract is linked");
    // "Approve and send" opens the payout approval; the acknowledgement and the button are inside it.
    const approve = page.getByRole("button", { name: "Approve and send" });
    await approve.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByTestId("approve-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("EUR 3,100.00");
    const ack = dialog.getByLabel(/I have read the reasons above/);
    await ack.focus();
    await page.keyboard.press("Space");
    await expect(ack).toBeChecked();
    await page.keyboard.press("Tab"); // Cancel
    await page.keyboard.press("Tab");
    const send = dialog.getByRole("button", { name: "Acknowledge and send" });
    await expect(send).toBeFocused();
    await expect(send).toBeEnabled();
    // Not pressed here: sending reads the Airwallex sandbox balance, which this run does not call.
    await axe(page, "evidence-send", info);
  });

  test("without the acknowledgement the send is refused by the server and nothing is sent", async ({
    page,
  }) => {
    const paymentId = await newDraft();
    await signIn(page, "owner");
    await page.goto(`/payments/${paymentId}/evidence`);
    const res = await page.request.post(`/api/v1/payments/${paymentId}/send`, { data: {} });
    expect(res.status()).toBe(412);
    const body = (await res.json()) as {
      error: { details: { reason: string; check: { flag: string } } };
    };
    expect(body.error.details).toMatchObject({
      reason: "evidence_ack_required",
      check: { flag: "missing" },
    });
    const sent = await withDb(async (c) =>
      Number(
        (
          await c.query("select count(*)::int as n from execution_attempts where ref_id = $1", [
            paymentId,
          ])
        ).rows[0]?.n,
      ),
    );
    expect(sent).toBe(0);
  });

  test("a viewer sees the evidence but has no controls to change or send it", async ({ page }) => {
    const paymentId = await newDraft();
    await signIn(page, "judge");
    await page.goto(`/payments/${paymentId}/evidence`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Nordlicht Software GmbH");
    await expect(page.getByRole("button", { name: /send/i })).toHaveCount(0);
    await expect(page.getByText("Only the owner can send a payment.")).toBeVisible();
  });

  test("another payment id is a 404", async ({ page }) => {
    await signIn(page, "owner");
    await page.goto(`/payments/${randomUUID()}/evidence`);
    // The page streams its loading state first, so the status line is 200; the content is the 404 page.
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });
});

test.describe("payment queue", () => {
  test("lists payments with their evidence strength; the flag filter is in the URL", async ({
    page,
  }, info) => {
    await newDraft();
    await signIn(page, "owner");
    await page.goto("/queue");
    await expect(page.getByRole("heading", { level: 1, name: "Payments" })).toBeVisible();
    const row = page.locator("[data-payment-id]").filter({ hasText: "Not sent" }).first();
    await expect(row).toBeVisible();
    await expect(row.locator("[data-flag]")).toContainText(
      /Evidence missing|Weak evidence|Strong evidence/,
    );
    await expect(row).toContainText("Not sent");
    await axe(page, "queue", info);

    // Filter by flag with the keyboard; the URL carries it and the list narrows.
    await page.getByRole("button", { name: "Strong", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/flag=strong/);
    await expect(page.getByRole("button", { name: "Strong", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.goto("/queue?show=paid&flag=missing");
    await expect(
      page.getByRole("heading", { name: "No payments match these filters" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).not.toHaveURL(/flag=/);
    await expect(row).toBeVisible();
  });
});
