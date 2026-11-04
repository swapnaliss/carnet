// Test support for the database-backed apps/web tests: an isolated database per test file
// (packages/db harness, `carnet_test_web_<worker>`), the recorded webhook deliveries from M0-05
// re-signed with a test secret, and an Airwallex client served from recorded responses. Importing the
// airwallex fixture loader replaces globalThis.fetch with a guard, so nothing reaches the network.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeWebhookSignature } from "@carnet/airwallex";
import { createBusiness, createPayment, type Db, getPayment, repoCtx } from "@carnet/db";
import {
  type BusinessId,
  type Currency,
  money,
  type PaymentId,
  type TransferStatus,
} from "@carnet/domain";
import {
  blockedCalls,
  FetchStub,
  loadFixture,
  makeClient,
} from "../../../packages/airwallex/test/fixture-loader";
import { useTestDatabase, withClient } from "../../../packages/db/test/harness";

export { blockedCalls, FetchStub, loadFixture, makeClient };

export const TEST_WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";

/** One isolated database for this test file (call at the top level). */
export function useWebTestDatabase() {
  return useTestDatabase({ prefix: "web" });
}

export const WEBHOOK_DIR = fileURLToPath(
  new URL("../../../fixtures/airwallex/webhooks/", import.meta.url),
);

export interface RecordedDelivery {
  file: string;
  body: string;
  event: { id: string; name: string; data: Record<string, unknown> };
}

/** Every recorded delivery (25 files, 24 distinct event ids: two are redeliveries). */
export function recordedDeliveries(): RecordedDelivery[] {
  return readdirSync(WEBHOOK_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
    .sort()
    .map((file) => {
      const raw = JSON.parse(readFileSync(`${WEBHOOK_DIR}${file}`, "utf8")) as {
        body_utf8: string;
      };
      return { file, body: raw.body_utf8, event: JSON.parse(raw.body_utf8) };
    });
}

export function delivery(file: string): RecordedDelivery {
  const d = recordedDeliveries().find((x) => x.file === `${file}.json`);
  if (!d) throw new Error(`no recorded delivery ${file}`);
  return d;
}

/** Headers for `body` signed the way Airwallex signs (hex HMAC-SHA256 of timestamp + body). */
export function signedHeaders(
  body: string,
  options: { secret?: string; timestampMs?: number } = {},
): Record<string, string> {
  const ts = String(options.timestampMs ?? Date.now());
  return {
    "content-type": "application/json",
    "x-timestamp": ts,
    "x-signature": computeWebhookSignature(options.secret ?? TEST_WEBHOOK_SECRET, ts, body),
  };
}

export function webhookRequest(body: string, headers: Record<string, string>): Request {
  return new Request("http://localhost/api/webhooks/airwallex", {
    method: "POST",
    headers,
    body,
  });
}

/** A business and one payment, optionally already linked to a transfer. */
export async function seedPayment(
  db: Db,
  appUrl: string,
  input: {
    transferId?: string;
    status?: TransferStatus;
    updatedAt?: Date;
    currency?: Currency;
  } = {},
): Promise<{ businessId: BusinessId; paymentId: PaymentId }> {
  const businessId = await createBusiness(db, { name: "Test Co" });
  const ctx = repoCtx(db, businessId);
  const payment = await createPayment(ctx, {
    amount: money(2000n, input.currency ?? "USD"),
    sourceCurrency: input.currency ?? "USD",
    method: "LOCAL",
    reference: "test",
  });
  if (input.transferId) {
    // Links the transfer as M1-08's executor will (status may still be unknown).
    await withClient(appUrl, (c) =>
      c.query(
        "UPDATE payments SET transfer_id = $1, transfer_status = $2, transfer_updated_at = $3 WHERE id = $4",
        [input.transferId, input.status ?? null, input.updatedAt ?? null, payment.id],
      ),
    );
  }
  return { businessId, paymentId: payment.id };
}

export async function paymentRow(db: Db, ref: { businessId: BusinessId; paymentId: PaymentId }) {
  const row = await getPayment(repoCtx(db, ref.businessId), ref.paymentId);
  if (!row) throw new Error(`payment ${ref.paymentId} not found`);
  return row;
}

/** Runs one SQL statement as the app role and returns its rows. */
export function query<T = Record<string, unknown>>(
  appUrl: string,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withClient(appUrl, async (c) => (await c.query(text, params)).rows as T[]);
}

/** A stub GET /transfers/{id} that answers whatever `current()` holds (wire shape). */
export function transferRoute(stub: FetchStub, current: (id: string) => unknown): FetchStub {
  return stub.on("GET", /^\/api\/v1\/transfers\/[^/]+$/, (call) => {
    const id = call.path.split("/").pop() ?? "";
    const body = current(id);
    if (body === undefined) {
      return new Response(JSON.stringify({ code: "resource_not_found", message: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

/** Wire-shaped RFI from a recorded fetch, re-keyed to `id`. */
export function recordedRfi(id: string): Record<string, unknown> {
  const body = loadFixture("rfi-check1-fetch").response.body as Record<string, unknown>;
  return { ...body, id };
}
