import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { expect, type Page } from "@playwright/test";
import pg from "pg";

// Shared by the evidence e2e specs (M2-03): sign-in, direct database access for what the extraction
// worker would store, and the scan upload.
export const ownerPassword = process.env.SEED_OWNER_PASSWORD;
export const judgePassword = process.env.SEED_JUDGE_PASSWORD;
export const databaseUrl = process.env.DATABASE_URL;
export const DATASET = new URL("../../../fixtures/dataset/", import.meta.url);

export async function signIn(page: Page, role: "owner" | "judge") {
  const email = role === "owner" ? "owner@carnet.example" : "judge@carnet.example";
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email, password: role === "owner" ? ownerPassword : judgePassword },
  });
  expect(res.status(), await res.text()).toBe(200);
}

export async function withDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A saved (unsent) EUR 3,100.00 payment to Nordlicht Software GmbH, the payee of the dataset's scan. */
export async function newDraft(): Promise<string> {
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
export async function storeScanFacts(documentId: string): Promise<void> {
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

/** The dataset's scanned invoice as a PNG with a unique text chunk, so each run uploads a new document. */
export function uniqueScan(): Buffer {
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

export async function uploadScan(page: Page): Promise<string> {
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
