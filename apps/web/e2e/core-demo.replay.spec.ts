import { execFileSync } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";

// The core demo, CI REPLAY variant (M2-09): no network, nothing live. Only with E2E_MODE=replay.
//
// What it replays: the database is seeded (apps/web/e2e/fixtures/seed-m2-run.ts) with REAL pipeline
// output over the model responses recorded in the live run (fixtures/anthropic/m2-run/): the dataset
// PDFs, their facts from the real extraction pipeline, and the RFI drafted by the real `rfi.draft`
// handler. Then the real UI of the production build is driven: the queue's Strong flag for the Harbor
// payment, the evidence view, the hold screen (drafted answers, verbatim source snippets, "Quote
// verified", the question the verifier rejected, as in the live run), the owner's own statement, and the
// owner approval.
//
// What it does NOT cover (the live run, core-demo.live.spec.ts and docs/evidence, did): the sandbox
// transfers, the simulated RFI and its signed webhook, the respond call to Airwallex, ANSWERED, closing
// the RFI and the transfer reaching SENT and PAID. Those need the Airwallex sandbox; this spec stops at
// "Approved by you" (the approval is stored; no worker runs in this job).
//
// Needs DATABASE_URL and the SEED_*_PASSWORD variables and the web server on the same database (the CI
// Playwright job has them); without them, or without E2E_MODE=replay, it is skipped loudly.
const ownerPassword = process.env.SEED_OWNER_PASSWORD;
test.skip(
  process.env.E2E_MODE !== "replay",
  "core demo replay: set E2E_MODE=replay (the live variant is core-demo.live.spec.ts).",
);
test.skip(
  !ownerPassword || !process.env.SEED_JUDGE_PASSWORD || !process.env.DATABASE_URL,
  "DATABASE_URL and SEED_*_PASSWORD are not set; the core demo replay is skipped.",
);
test.describe.configure({ mode: "serial" });

interface Seeded {
  strong: string;
  weak: string;
  rfi: string;
  reference: string;
}
let ids: Seeded;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(150_000);
  const out = execFileSync("npx", ["tsx", "apps/web/e2e/fixtures/seed-m2-run.ts"], {
    encoding: "utf8",
    env: process.env,
    timeout: 120_000,
  })
    .trim()
    .split("\n")
    .at(-1);
  ids = JSON.parse(out ?? "{}") as Seeded;
  page = await browser.newPage({
    baseURL: test.info().project.use.baseURL ?? "http://localhost:3000",
  });
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: "owner@carnet.example", password: ownerPassword },
  });
  expect(res.status(), await res.text()).toBe(200);
});
test.afterAll(async () => {
  await page.close();
});

test("the queue shows the Strong flag for the Harbor payment and not for the Lakeside one", async () => {
  await page.goto("/queue");
  await expect(page.getByRole("heading", { level: 1, name: "Payments" })).toBeVisible();
  const harbor = page.locator(`[data-payment-id="${ids.strong}"]`);
  await expect(harbor.first()).toBeVisible();
  await expect(harbor.first().locator("[data-flag]")).toContainText("Strong evidence");
  const lakeside = page.locator(`[data-payment-id="${ids.weak}"]`);
  await expect(lakeside.first().locator("[data-flag]")).not.toContainText("Strong evidence");
});

test("the evidence view lists the linked documents of the Harbor payment", async () => {
  await page.goto(`/payments/${ids.weak}/evidence`);
  await expect(page.getByTestId("reasons")).toBeVisible();
  await page.goto(`/payments/${ids.strong}/evidence`);
  await expect(page.getByTestId("reasons")).toBeVisible();
  await expect(page.getByText("inv-harbor-001.pdf").first()).toBeVisible();
  await expect(page.getByText("contract-harbor.pdf").first()).toBeVisible();
});

test("the hold screen shows drafted answers with verbatim snippets and 'Quote verified'", async () => {
  await page.goto(`/rfis/${ids.rfi}`);
  await expect(page.getByTestId("hold-screen")).toBeVisible();
  await expect(page.getByTestId("question")).toHaveCount(4);
  const purpose = page.getByTestId("question").filter({ hasText: "Purpose of payment" });
  await expect(purpose.getByTestId("question-status")).toHaveText("Ready");
  await expect(purpose.getByTestId("source-quote").first()).toContainText(
    "Invoice number: INV-HP-2026-0141",
  );
  await expect(purpose.getByTestId("source-snippet").first()).toContainText("Quote verified");
  await expect(purpose.getByTestId("claim").first()).toContainText("INV-HP-2026-0141");
  // As in the live run, the verifier rejected the model's relationship answer: it is not shown as ready.
  const relationship = page
    .getByTestId("question")
    .filter({ hasText: "Relationship with the counterparty" });
  await expect(relationship.getByTestId("needs-owner")).toBeVisible();
  await expect(page.getByTestId("approve-button")).toHaveAttribute("aria-disabled", "true");
});

test("the owner writes the declined answer and approves exactly what is shown", async () => {
  await page.goto(`/rfis/${ids.rfi}`);
  const relationship = page
    .getByTestId("question")
    .filter({ hasText: "Relationship with the counterparty" });
  await relationship.getByRole("button", { name: "Write an answer" }).click();
  await relationship
    .getByRole("textbox", { name: "Your statement" })
    .fill(
      "Harbor Print Co. is our regular printing supplier. We buy brochures and posters from them under a written supply agreement, and this payment settles one of their invoices.",
    );
  await relationship.getByRole("button", { name: "Save edit" }).click();
  await expect(relationship.getByTestId("question-status")).not.toHaveAttribute(
    "data-status",
    "needs_owner",
  );
  await expect(page.getByTestId("approve-button")).toHaveAttribute("aria-disabled", "false");
  await page.getByTestId("approve-button").click();
  const dialog = page.getByTestId("approve-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Approve and submit \d+ answers/ }).click();
  await expect(page.getByTestId("approval-status")).toContainText("Approved by you");
});
