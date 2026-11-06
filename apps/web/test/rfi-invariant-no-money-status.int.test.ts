// M2-04 AC 7: no RFI event and no RFI state transition changes `transfer_status` (ADR 0006).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TRANSFER_STATUSES } from "@carnet/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "../src/app/api/webhooks/airwallex/route";
import { closeAppDb } from "../src/server/db";
import {
  closedUnanswered,
  followUpSequence,
  retarget,
  rfiEventBody,
  rfiHarness,
  uid,
} from "./rfi-support";
import {
  blockedCalls,
  paymentRow,
  query,
  seedPayment,
  signedHeaders,
  TEST_WEBHOOK_SECRET,
  webhookRequest,
  webTestDatabase,
} from "./support";

const db = webTestDatabase();

beforeAll(() => {
  process.env.DATABASE_URL = db().appUrl;
  process.env.AIRWALLEX_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
});
afterAll(async () => {
  await closeAppDb();
  expect(blockedCalls).toEqual([]);
});

describe("runtime: every RFI snapshot, against a payment in every transfer status", () => {
  it("leaves transfer_status, transfer_updated_at and the payment row exactly as they were", async () => {
    const h = rfiHarness(db().app.db);
    const sequence = [...followUpSequence(), closedUnanswered()];
    const watched = [];
    for (const status of TRANSFER_STATUSES) {
      const transferId = uid("77777777");
      const ref = await seedPayment(db().app.db, db().appUrl, {
        transferId,
        status,
        updatedAt: new Date("2026-11-03T09:57:00Z"),
      });
      watched.push({ transferId, ref });
    }
    const before = await Promise.all(watched.map((w) => paymentRow(db().app.db, w.ref)));

    for (const w of watched) {
      const id = uid("88888888");
      for (const snap of sequence) {
        // No account mapping: each RFI is attributed to the business that owns its transfer.
        h.current.set(
          id,
          retarget(snap, { id, accountId: "acct_not_mapped", transferId: w.transferId }),
        );
        const body = rfiEventBody(id);
        expect((await POST(webhookRequest(body, signedHeaders(body)))).status).toBe(200);
        await h.drain();
      }
    }
    // Each RFI linked to its payment (so the invariant is tested where it matters).
    const linked = await query<{ payment_id: string | null }>(
      db().appUrl,
      "SELECT payment_id FROM rfis",
    );
    expect(linked.map((r) => r.payment_id).sort()).toEqual(
      watched.map((w) => w.ref.paymentId).sort(),
    );

    const after = await Promise.all(watched.map((w) => paymentRow(db().app.db, w.ref)));
    expect(after).toEqual(before);
    expect(after.map((p) => p.transferStatus)).toEqual([...TRANSFER_STATUSES]);
    expect(h.stub.count("GET", /^\/api\/v1\/transfers/)).toBe(0);
    const rfis = await query<{ state: string }>(db().appUrl, "SELECT state FROM rfis");
    expect(rfis).toHaveLength(TRANSFER_STATUSES.length);
  });
});

describe("static: the RFI code never writes a transfer status", () => {
  const files = [
    "../src/worker/handlers/rfi.ts",
    "../src/server/rfi-routes.ts",
    "../../../packages/db/src/repos/rfis.ts",
    "../../../packages/db/src/repos/rfi-attribution.ts",
    "../../../packages/domain/src/rfi/state-machine.ts",
    "../../../packages/domain/src/rfi/ingest.ts",
  ];
  it.each(files)("%s does not touch payments' transfer columns", (rel) => {
    const text = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    expect(text).not.toMatch(
      /updatePaymentTransfer|transferStatus\s*:|transfer_status\s*=|applyTransferUpdate/,
    );
    expect(text).not.toMatch(/\.update\(payments\)/);
  });
});
