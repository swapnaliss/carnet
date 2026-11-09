import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { crc32 } from "node:zlib";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import pg from "pg";

// The payment queue and the evidence view (M2-03), end to end on the production build. Needs the web
// server started with DATABASE_URL and BETTER_AUTH_* and the demo users seeded (`npx tsx
// packages/db/src/seed/run.ts` with the SEED_* passwords); without them the tests are skipped loudly.
//
// The extraction worker is not part of this run (it calls a model). Where the worker would store the
// extracted facts of the uploaded scan, the test stores them itself, from the recorded real model
// response, as an image-only document produces them (not verified, needs confirmation).
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const ownerPassword = process.env.SEED_OWNER_PASSWORD;
const judgePassword = process.env.SEED_JUDGE_PASSWORD;
const databaseUrl = process.env.DATABASE_URL;
const reviewDir = process.env.E2E_REVIEW_DIR;

const DATASET = new URL("../../../fixtures/dataset/", import.meta.url);

test.skip(
  !ownerPassword || !judgePassword || !databaseUrl,
  "SEED_* passwords and DATABASE_URL are not set; the evidence e2e is skipped.",
);

async function signIn(page: Page, role: "owner" | "judge") {
  const email = role === "owner" ? "owner@carnet.example" : "judge@carnet.example";
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email, password: role === "owner" ? ownerPassword : judgePassword },
  });
  expect(res.status(), await res.text()).toBe(200);
}

async function withDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A saved (unsent) EUR 3,100.00 payment to Nordlicht Software GmbH, the payee of the dataset's scan. */
async function newDraft(): Promise<string> {
  return withDb(async (c) => {
    const biz = (await c.query<{ id: string }>("select id from businesses limit 1")).rows[0]?.id;
    const cp = (
      await c.query<{ id: string }>(
        "insert into counterparties (business_id, name, country) values ($1, 'Nordlicht Software GmbH', 'DE') returning id",
        [biz],
      )
    ).rows[0]?.id;
    return (
      await c.query<{ id: string }>(
        `insert into payments (business_id, counterparty_id, amount_minor, currency, source_currency, method, reference)
         values ($1, $2, 310000, 'EUR', 'EUR', 'SWIFT', $3) returning id`,
        [biz, cp, `NL-2026-0341 ${randomUUID().slice(0, 8)}`],
      )
    ).rows[0]?.id as string;
  });
}

/**
 * What the worker stores for the scan: the facts of the recorded real model response for this document
 * (fixtures/anthropic/extraction), every one unverified and waiting for the owner, as an image-only
 * document produces them.
 */
async function storeScanFacts(documentId: string): Promise<void> {
  const recorded = JSON.parse(
    readFileSync(
      new URL(
        "../../../fixtures/anthropic/extraction/inv-nordlicht-scan-001-png.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { calls: { response: { content: { type: string; text?: string }[] } }[] };
  const text = recorded.calls[0]?.response.content.find((b) => b.type === "text")?.text ?? "{}";
  const output = JSON.parse(text) as {
    facts: { key: string; value: string; quote: string; page: number }[];
  };
  const wanted = new Set(["invoice_number", "supplier", "total"]);
  const facts = output.facts
    .filter((f) => wanted.has(f.key))
    .map((f) => ({
      ...f,
      parsed:
        f.key === "total"
          ? { type: "amount", minor: f.value.replace(/\D/g, ""), currency: "EUR" }
          : { type: "text", text: f.value },
      quote_verified: false,
      needs_confirmation: true,
      issues: ["no_text_layer"],
    }));
  await withDb(async (c) => {
    const biz = (
      await c.query<{ business_id: string }>("select business_id from documents where id = $1", [
        documentId,
      ])
    ).rows[0]?.business_id;
    await c.query(
      `insert into document_facts (business_id, document_id, version, source, status, text_layer, facts, quotes, quotes_verified, extraction_key)
       values ($1, $2, 1, 'model', 'EXTRACTED', false, $3::jsonb, '[]'::jsonb, false, $4)`,
      [biz, documentId, JSON.stringify(facts), `e2e-${documentId}`],
    );
  });
}

/**
 * Gives the queue one Strong, one Weak and one paid payment next to the drafts, for the design review:
 * documents from the dataset with verified facts, as the extraction stores them (fixtures/dataset).
 */
async function seedReviewQueue(): Promise<void> {
  await withDb(async (c) => {
    const biz = (await c.query<{ id: string }>("select id from businesses limit 1")).rows[0]?.id;
    const owner = (
      await c.query<{ id: string }>("select id from users where email = 'owner@carnet.example'")
    ).rows[0]?.id;
    const cp = (
      await c.query<{ id: string }>(
        "insert into counterparties (business_id, name, country) values ($1, 'Harbor Print Co.', 'US') returning id",
        [biz],
      )
    ).rows[0]?.id;
    const payment = async (minor: number, reference: string, sent: boolean) =>
      (
        await c.query<{ id: string }>(
          `insert into payments (business_id, counterparty_id, amount_minor, currency, source_currency, method, reference, transfer_id, transfer_status, transfer_updated_at)
           values ($1, $2, $3, 'USD', 'USD', 'LOCAL', $4, $5, $6, $7) returning id`,
          [
            biz,
            cp,
            minor,
            reference,
            sent ? `tr_review_${randomUUID()}` : null,
            sent ? "PAID" : null,
            sent ? new Date() : null,
          ],
        )
      ).rows[0]?.id as string;
    const invoice = async (file: string, total: number) => {
      const bytes = readFileSync(new URL(file, DATASET));
      const sha = createHash("sha256").update(bytes).digest("hex");
      await c.query(
        `insert into documents (business_id, kind, filename, mime, size, sha256, bytes)
         values ($1, 'invoice', $2, 'application/pdf', $3, $4, $5) on conflict (business_id, sha256) do nothing`,
        [biz, file, bytes.length, sha, bytes],
      );
      const id = (
        await c.query<{ id: string }>(
          "select id from documents where business_id = $1 and sha256 = $2",
          [biz, sha],
        )
      ).rows[0]?.id;
      const facts = [
        {
          key: "supplier",
          value: "Harbor Print Co.",
          parsed: { type: "text", text: "Harbor Print Co." },
          quote: "From: Harbor Print Co.",
          page: 1,
          quote_verified: true,
          needs_confirmation: false,
          issues: [],
        },
        {
          key: "total",
          value: `USD ${(total / 100).toFixed(2)}`,
          parsed: { type: "amount", minor: String(total), currency: "USD" },
          quote: `Total due: USD ${(total / 100).toFixed(2)}`,
          page: 1,
          quote_verified: true,
          needs_confirmation: false,
          issues: [],
        },
      ];
      await c.query(
        `insert into document_facts (business_id, document_id, version, source, status, text_layer, facts, quotes, quotes_verified, extraction_key)
         values ($1, $2, 1, 'model', 'EXTRACTED', true, $3::jsonb, '[]'::jsonb, true, $4) on conflict do nothing`,
        [biz, id, JSON.stringify(facts), `review-${id}-${total}`],
      );
      return id;
    };
    const link = (paymentId: string, documentId: string | undefined) =>
      c.query(
        "insert into evidence_links (business_id, payment_id, document_id, created_by) values ($1, $2, $3, $4) on conflict do nothing",
        [biz, paymentId, documentId, owner],
      );
    await link(
      await payment(48_000, "INV-HP-0042", false),
      await invoice("inv-harbor-001.pdf", 48_000),
    );
    await link(
      await payment(90_000, "INV-HP-0043", false),
      await invoice("inv-harbor-002.pdf", 90_500),
    );
    await link(
      await payment(48_000, "INV-HP-0041", true),
      await invoice("inv-harbor-001.pdf", 48_000),
    );
  });
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

/** The dataset's scanned invoice as a PNG with a unique text chunk, so each run uploads a new document. */
function uniqueScan(): Buffer {
  const png = readFileSync(new URL("scans/inv-nordlicht-scan-001.png", DATASET));
  const body = Buffer.concat([Buffer.from("Comment\0"), Buffer.from(`e2e ${randomUUID()}`)]);
  const type = Buffer.from("tEXt");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, body])));
  const chunk = Buffer.concat([length, type, body, crc]);
  const iend = png.length - 12; // length (4) + "IEND" (4) + crc (4)
  return Buffer.concat([png.subarray(0, iend), chunk, png.subarray(iend)]);
}

async function uploadScan(page: Page): Promise<string> {
  await page.getByLabel("File").setInputFiles({
    name: "inv-nordlicht-scan-001.png",
    mimeType: "image/png",
    buffer: uniqueScan(),
  });
  // Keyboard: the kind select is already "Invoice"; the submit button takes Enter.
  await page.getByLabel("File").focus();
  const added = page.waitForResponse(
    (r) => r.url().includes("/evidence-links") && r.request().method() === "POST",
  );
  await page.keyboard.press("Tab"); // to the kind select
  await page.keyboard.press("Tab"); // to the submit button
  await page.keyboard.press("Enter");
  expect((await added).status()).toBe(201);
  const doc = page.locator("[data-document]").first();
  await expect(doc).toBeVisible();
  return (await doc.getAttribute("data-document")) ?? "";
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
    const ack = page.getByLabel(/I have read the reasons above/);
    await ack.focus();
    await page.keyboard.press("Space");
    await expect(ack).toBeChecked();
    await page.keyboard.press("Tab");
    const send = page.getByRole("button", { name: "Acknowledge and send" });
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
    await expect(page.getByRole("heading", { level: 1, name: "Payment queue" })).toBeVisible();
    const row = page.locator("[data-payment-id]").first();
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
    await expect(
      page.getByRole("heading", { name: "No payments match these filters" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page).not.toHaveURL(/flag=/);
    await expect(row).toBeVisible();
  });
});

// Review captures for the independent design review (Phase 6b): 375 / 768 / 1440, light and dark.
test.describe("review screenshots", () => {
  test.skip(
    !reviewDir,
    "E2E_REVIEW_DIR is not set; screenshots are written only for the design review.",
  );
  const widths = [375, 768, 1440] as const;
  for (const scheme of ["light", "dark"] as const) {
    for (const width of widths) {
      test(`${scheme} ${width}`, async ({ page }, info) => {
        info.setTimeout(90_000);
        const dir = resolve(reviewDir ?? ".", "");
        mkdirSync(dir, { recursive: true });
        const tag = `${scheme}-${width}`;
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        // The first paint is a moment, not a state: a screenshot that cannot be taken in it is skipped.
        const firstPaint = async (file: string) => {
          await page.screenshot({ path: resolve(dir, file) }).catch(() => undefined);
        };
        // A screenshot and its axe result (serious and critical violations fail the capture).
        const capture = async (name: string) => {
          await page.screenshot({ path: resolve(dir, `${name}-${tag}.png`), fullPage: true });
          const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
          writeFileSync(resolve(dir, `axe-${name}-${tag}.json`), JSON.stringify(results, null, 2));
          const blocking = results.violations.filter(
            (v) => v.impact === "serious" || v.impact === "critical",
          );
          expect(blocking.map((v) => `${name} ${v.id}: ${v.help}`)).toEqual([]);
        };
        const paymentId = await newDraft();
        await signIn(page, "owner");

        // The loading state streams first; capture it as soon as the response starts.
        await page.goto(`/payments/${paymentId}/evidence`, { waitUntil: "commit" });
        await firstPaint(`evidence-first-paint-${tag}.png`);
        await expect(page.getByRole("heading", { level: 1 })).toContainText("Nordlicht");
        await capture("evidence-empty");
        const documentId = await uploadScan(page);
        await capture("evidence-reading");
        await storeScanFacts(documentId);
        await expect(page.locator("[data-fact]")).toHaveCount(3, { timeout: 15_000 });
        await capture("evidence-documents-needs-confirmation");
        for (const box of await page.getByRole("checkbox", { name: /^Confirm / }).all())
          await box.check();
        await page.getByRole("button", { name: /^Confirm 3 facts$/ }).click();
        await expect(page.locator('[data-fact="total"]')).toContainText("Confirmed by you", {
          timeout: 15_000,
        });
        await capture("evidence-documents-confirmed");
        await page.getByRole("tab", { name: "Checks" }).click();
        await capture("evidence-checks");
        await page.getByLabel(/I have read the reasons above/).check();
        await capture("evidence-send-acknowledged");

        await seedReviewQueue();
        await page.goto("/queue", { waitUntil: "commit" });
        await firstPaint(`queue-first-paint-${tag}.png`);
        await expect(page.getByTestId("queue-summary")).toBeVisible();
        await capture("queue");
        await page.goto("/queue?flag=missing&status=paid");
        await expect(
          page.getByRole("heading", { name: "No payments match these filters" }),
        ).toBeVisible();
        await capture("queue-filtered-empty");
      });
    }
  }
});
