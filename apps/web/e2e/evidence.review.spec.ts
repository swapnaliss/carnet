import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  DATASET,
  databaseUrl,
  newDraft,
  ownerPassword,
  signIn,
  storeScanFacts,
  uploadScan,
  withDb,
} from "./evidence-support";

// Design-review captures for M2-03 (/start Phase 6b): every state of the queue and the evidence view at
// 375 / 768 / 1440, light and dark, each with its axe result (serious and critical violations fail).
// Written only when E2E_REVIEW_DIR is set. Rows are seeded straight into the database the way the app
// stores them (documents with verified facts, an RFI linked to a payment, an attempt): no mocks.
const reviewDir = process.env.E2E_REVIEW_DIR;
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.skip(!reviewDir || !ownerPassword || !databaseUrl, "E2E_REVIEW_DIR is not set.");

const fact = (key: string, value: string, parsed: unknown, quote: string, extra = {}) => ({
  key,
  value,
  parsed,
  quote,
  page: 1,
  quote_verified: true,
  needs_confirmation: false,
  issues: [],
  ...extra,
});

interface Seeded {
  held: string;
  weak: string;
  strong: string;
  waiting: string;
  sent: string;
  injection: string;
  failed: string;
}

async function seed(): Promise<Seeded> {
  return withDb(async (c) => {
    const biz = (await c.query<{ id: string }>("select id from businesses limit 1")).rows[0]?.id;
    // Seeded once: later calls look the payments up by their references.
    const byRef = async (ref: string) =>
      (await c.query<{ id: string }>("select id from payments where reference = $1 limit 1", [ref]))
        .rows[0]?.id as string;
    if (await byRef("RD-2026-1233")) {
      return {
        held: await byRef("RD-2026-1233"),
        weak: await byRef("INV-HP-0043"),
        strong: await byRef("INV-HP-0042"),
        waiting: await byRef("INV-HP-0044"),
        sent: await byRef("INV-HP-0041"),
        injection: await byRef("LF-2026-0455"),
        failed: await byRef("RD-2026-1180"),
      };
    }
    const owner = (
      await c.query<{ id: string }>("select id from users where email = 'owner@carnet.example'")
    ).rows[0]?.id;
    const cp = async (name: string, country: string) =>
      (
        await c.query<{ id: string }>(
          "insert into counterparties (business_id, name, country) values ($1, $2, $3) returning id",
          [biz, name, country],
        )
      ).rows[0]?.id;
    const harbor = await cp("Harbor Print Co.", "US");
    const rhein = await cp("Rheinblick Druck GmbH", "DE");
    const lakeside = await cp("Lakeside Freight LLC", "US");
    const pay = async (
      counterparty: string | undefined,
      minor: number,
      currency: string,
      reference: string,
      transfer: string | null = null,
    ) =>
      (
        await c.query<{ id: string }>(
          `insert into payments (business_id, counterparty_id, amount_minor, currency, source_currency, method, reference, transfer_id, transfer_status, transfer_updated_at)
           values ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9) returning id`,
          [
            biz,
            counterparty,
            minor,
            currency,
            currency === "EUR" ? "SWIFT" : "LOCAL",
            reference,
            transfer ? `tr_review_${randomUUID()}` : null,
            transfer,
            transfer ? new Date() : null,
          ],
        )
      ).rows[0]?.id as string;
    const doc = async (
      file: string,
      kind: string,
      facts: unknown[],
      over: { status?: string; failure?: string; flags?: unknown[] } = {},
    ) => {
      const bytes = readFileSync(new URL(file, DATASET));
      const sha = createHash("sha256").update(bytes).digest("hex");
      await c.query(
        `insert into documents (business_id, kind, filename, mime, size, sha256, bytes) values ($1, $2, $3, 'application/pdf', $4, $5, $6) on conflict (business_id, sha256) do nothing`,
        [biz, kind, file, bytes.length, sha, bytes],
      );
      const id = (
        await c.query<{ id: string }>(
          "select id from documents where business_id = $1 and sha256 = $2",
          [biz, sha],
        )
      ).rows[0]?.id;
      await c.query(
        `insert into document_facts (business_id, document_id, version, source, status, failure, text_layer, facts, quotes, quotes_verified, injection_flags, extraction_key)
         values ($1, $2, 1, 'model', $3, $4, true, $5::jsonb, '[]'::jsonb, $6, $7::jsonb, $8) on conflict do nothing`,
        [
          biz,
          id,
          over.status ?? "EXTRACTED",
          over.failure ?? null,
          JSON.stringify(facts),
          facts.length > 0,
          JSON.stringify(over.flags ?? []),
          `review-${id}`,
        ],
      );
      return id;
    };
    const link = (payment: string, document: string | undefined) =>
      c.query(
        "insert into evidence_links (business_id, payment_id, document_id, created_by) values ($1, $2, $3, $4) on conflict do nothing",
        [biz, payment, document, owner],
      );
    const text = (key: string, value: string, quote: string) =>
      fact(key, value, { type: "text", text: value }, quote);
    const amount = (key: string, minor: number, cur: string, quote: string) =>
      fact(
        key,
        `${cur} ${(minor / 100).toFixed(2)}`,
        { type: "amount", minor: String(minor), currency: cur },
        quote,
      );

    const invHarbor = await doc("inv-harbor-001.pdf", "invoice", [
      text("supplier", "Harbor Print Co.", "From: Harbor Print Co."),
      amount("total", 48_000, "USD", "Total due: USD 480.00"),
    ]);
    const invMismatch = await doc("inv-harbor-002.pdf", "invoice", [
      text("supplier", "Harbor Print Co.", "From: Harbor Print Co."),
      amount("total", 90_500, "USD", "Total due: USD 905.00"),
    ]);
    const invInject = await doc(
      "inv-lakeside-002.pdf",
      "invoice",
      [
        text("supplier", "Lakeside Freight LLC", "Supplier: Lakeside Freight LLC"),
        amount("total", 98_000, "USD", "Amount due: USD 980.00"),
      ],
      {
        flags: [
          {
            kind: "instruction",
            rule: "ignore-previous",
            match: "IGNORE ALL PREVIOUS INSTRUCTIONS",
          },
        ],
      },
    );
    const invFailed = await doc("inv-rhein-001.pdf", "invoice", [], {
      status: "EXTRACTION_FAILED",
      failure: "MODEL_ERROR",
    });

    const strong = await pay(harbor, 48_000, "USD", "INV-HP-0042");
    await link(strong, invHarbor);
    const weak = await pay(harbor, 90_000, "USD", "INV-HP-0043");
    await link(weak, invMismatch);
    const injection = await pay(lakeside, 98_000, "USD", "LF-2026-0455");
    await link(injection, invInject);
    const failed = await pay(rhein, 720_000, "EUR", "RD-2026-1180");
    await link(failed, invFailed);
    const sent = await pay(harbor, 48_000, "USD", "INV-HP-0041", "PAID");
    await link(sent, invHarbor);

    const waiting = await pay(harbor, 48_000, "USD", "INV-HP-0044");
    await link(waiting, invHarbor);
    await c.query(
      "insert into execution_attempts (business_id, kind, ref_id, request_id, status) values ($1, 'transfer', $2, $3, 'INTENT')",
      [biz, waiting, randomUUID()],
    );

    const held = await pay(rhein, 720_000, "EUR", "RD-2026-1233", "PROCESSING");
    await c.query(
      `insert into rfis (business_id, airwallex_rfi_id, type, airwallex_status, airwallex_updated_at, state, round, expires_at, payment_id, linked_by, source_key, conflict)
       values ($1, $2, 'TRANSACTION', 'ACTION_REQUIRED', now(), 'DRAFT_READY', 1, now() + interval '2 days', $3, 'match', $4, false)`,
      [biz, `rfi_review_${randomUUID()}`, held, `TRANSFER:tr_${randomUUID()}`],
    );
    return { held, weak, strong, waiting, sent, injection, failed };
  });
}

const widths = [375, 768, 1440] as const;
const schemes = ["light", "dark"] as const;

async function prepare(page: Page, scheme: (typeof schemes)[number], width: number) {
  const dir = resolve(reviewDir ?? ".");
  mkdirSync(dir, { recursive: true });
  const tag = `${scheme}-${width}`;
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  const capture = async (name: string) => {
    // The viewport is made as tall as the page, so fixed bars (skip link, tab bar, approve bar) appear
    // once, where they are, instead of being pasted mid-page as in a full-page capture.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width, height: Math.max(height, 600) });
    await page.screenshot({ path: resolve(dir, `${name}-${tag}.png`) });
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    writeFileSync(resolve(dir, `axe-${name}-${tag}.json`), JSON.stringify(results, null, 2));
    const blocking = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(blocking.map((v) => `${name} ${v.id}: ${v.help}`)).toEqual([]);
  };
  return capture;
}

// The queue first, on clean data: empty (no payments yet), then the seeded set.
test("review queue states", async ({ page }, info) => {
  info.setTimeout(300_000);
  await signIn(page, "owner");
  for (const scheme of schemes) {
    for (const width of widths) {
      const capture = await prepare(page, scheme, width);
      await page.goto("/queue");
      await expect(page.getByRole("heading", { name: "No payments yet" })).toBeVisible();
      await capture("queue-empty");
    }
  }
  const ids = await seed();
  for (const scheme of schemes) {
    for (const width of widths) {
      const capture = await prepare(page, scheme, width);
      await page.goto("/queue/preview-loading", { waitUntil: "commit" });
      await expect(page.getByText("Loading payments")).toBeVisible();
      await capture("queue-loading");
      await page.goto("/queue/preview-error");
      await expect(page.getByText(/could not load your payments/)).toBeVisible();
      await capture("queue-error");
      await page.goto("/queue");
      await expect(page.getByTestId("held-callout")).toBeVisible();
      await capture("queue");
      await page.goto("/queue?show=paid&flag=missing");
      await expect(
        page.getByRole("heading", { name: "No payments match these filters" }),
      ).toBeVisible();
      await capture("queue-filtered-empty");
      await page.goto(`/payments/${ids.weak}/evidence/preview-loading`, { waitUntil: "commit" });
      await expect(page.getByText("Loading evidence")).toBeVisible();
      await capture("evidence-loading");
      await page.goto(`/payments/${ids.weak}/evidence/preview-error`);
      await expect(page.getByText(/could not load the checks/)).toBeVisible();
      await capture("evidence-error");
    }
  }
});

for (const scheme of schemes) {
  for (const width of widths) {
    test(`review evidence ${scheme} ${width}`, async ({ page }, info) => {
      info.setTimeout(240_000);
      const capture = await prepare(page, scheme, width);
      await signIn(page, "owner");
      const ids = await seed();

      await page.goto(`/payments/${ids.strong}/evidence`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Harbor");
      await expect(page.getByTestId("reasons")).toContainText("Every check Carnet runs passed");
      await capture("evidence-strong");
      await page.getByRole("button", { name: "Approve and send" }).click();
      await expect(page.getByTestId("approve-dialog")).toBeVisible();
      await capture("evidence-approve-dialog-strong");
      await page.keyboard.press("Escape");

      await page.goto(`/payments/${ids.weak}/evidence`);
      await expect(page.getByTestId("reasons")).toContainText("does not match");
      await capture("evidence-weak-checks");
      await page.getByRole("tab", { name: /Documents/ }).click();
      await capture("evidence-weak-documents");
      await page.getByRole("button", { name: "Approve and send" }).click();
      await capture("evidence-approve-dialog-weak");
      await page.keyboard.press("Escape");

      await page.goto(`/payments/${ids.injection}/evidence#documents`);
      await expect(page.getByText("looks like instructions to an AI")).toBeVisible();
      await capture("evidence-injection");

      await page.goto(`/payments/${ids.failed}/evidence#documents`);
      await expect(page.getByText(/could not read this document/)).toBeVisible();
      await capture("evidence-extraction-failed");

      await page.goto(`/payments/${ids.waiting}/evidence`);
      await expect(page.getByText("Waiting for Airwallex to confirm")).toBeVisible();
      await capture("evidence-waiting-for-airwallex");

      await page.goto(`/payments/${ids.sent}/evidence`);
      await expect(
        page.getByRole("heading", { name: "Airwallex created the transfer" }),
      ).toBeVisible();
      await capture("evidence-sent");

      const paymentId = await newDraft();
      await page.goto(`/payments/${paymentId}/evidence`);
      await capture("evidence-empty");
      const documentId = await uploadScan(page);
      await capture("evidence-reading");
      await storeScanFacts(documentId);
      await expect(page.locator("[data-fact]")).toHaveCount(3, { timeout: 15_000 });
      await capture("evidence-needs-confirmation");
      for (const box of await page.getByRole("checkbox", { name: /^Confirm / }).all())
        await box.check();
      await page.getByRole("button", { name: /^Confirm 3 facts$/ }).click();
      await expect(page.locator('[data-fact="total"]')).toContainText("Confirmed by you", {
        timeout: 15_000,
      });
      await expect(page.getByTestId("reasons")).not.toContainText("not verified");
      await capture("evidence-confirmed");
      await page.getByRole("tab", { name: "Checks" }).click();
      await capture("evidence-checks-after-confirm");

      // Stale: the evidence cannot be refreshed, so the banner shows after 15 s, the data stays and sending is paused.
      await page.route(/evidence-check/, (route) => route.abort());
      await expect(page.getByTestId("stale-banner")).toBeVisible({ timeout: 40_000 });
      await expect(page.getByRole("button", { name: "Approve and send" })).toBeDisabled();
      await capture("evidence-stale");
    });
  }
}
