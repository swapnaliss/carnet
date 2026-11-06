// M2-04 AC 4: parallel and duplicate deliveries, two workers claiming jobs at once, leave one open RFI
// per business, type and source, one DRAFTING transition and no duplicate rfi.draft jobs.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../src/app/api/webhooks/airwallex/route";
import { closeAppDb } from "../src/server/db";
import {
  fixtureRfi,
  newBusiness,
  resetRfiTables,
  retarget,
  rfiEventBody,
  rfiHarness,
  uid,
} from "./rfi-support";
import {
  blockedCalls,
  query,
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
beforeEach(async () => {
  await resetRfiTables(db().appUrl);
});

async function post(body: string): Promise<void> {
  expect((await POST(webhookRequest(body, signedHeaders(body)))).status).toBe(200);
}

describe("one RFI delivered many times in parallel", () => {
  it("six deliveries (three of the same event), two workers: one row, one DRAFTING, one rfi.draft", async () => {
    const { businessId, accountId } = await newBusiness(db().app.db);
    const id = uid("a1a1a1a1");
    const h = rfiHarness(db().app.db, { workers: 2 });
    h.current.set(
      id,
      retarget(fixtureRfi("rfi-check1-fetch"), { id, accountId, transferId: uid("b2b2b2b2") }),
    );

    const same = rfiEventBody(id); // one event id, delivered three times
    const bodies = [
      same,
      same,
      same,
      rfiEventBody(id),
      rfiEventBody(id, "rfi.answered"),
      rfiEventBody(id),
    ];
    await Promise.all(bodies.map(post));
    // Four distinct event ids became four rfi.sync jobs; the repeated event id was de-duplicated.
    expect(
      await query(db().appUrl, "SELECT 1 FROM outbox_jobs WHERE kind = 'rfi.sync'"),
    ).toHaveLength(4);
    await h.drain();

    const rows = await query<{ state: string; business_id: string }>(
      db().appUrl,
      "SELECT * FROM rfis",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "DRAFTING", business_id: businessId });
    expect(
      await query(db().appUrl, "SELECT 1 FROM outbox_jobs WHERE kind = 'rfi.draft'"),
    ).toHaveLength(1);
    const transitions = await query(
      db().appUrl,
      "SELECT 1 FROM audit_log WHERE action = 'rfi.transition' AND business_id = $1",
      [businessId],
    );
    expect(transitions).toHaveLength(1);
    expect(
      await query(
        db().appUrl,
        "SELECT 1 FROM outbox_jobs WHERE kind = 'rfi.sync' AND status <> 'DONE'",
      ),
    ).toEqual([]);
  });
});

describe("two RFIs for the same type and source delivered simultaneously (ADR 0018 amendment 1)", () => {
  it("exactly one open RFI is not a conflict; the other is stored, flagged, and not drafted", async () => {
    const { businessId, accountId } = await newBusiness(db().app.db);
    const transferId = uid("c3c3c3c3");
    const ids = [uid("d4d4d4d4"), uid("d5d5d5d5")];
    const h = rfiHarness(db().app.db, { workers: 2 });
    for (const id of ids) {
      h.current.set(id, retarget(fixtureRfi("rfi-check1-fetch"), { id, accountId, transferId }));
    }

    await Promise.all(ids.flatMap((id) => [post(rfiEventBody(id)), post(rfiEventBody(id))]));
    await h.drain();

    const rows = await query<{ state: string; conflict: boolean }>(
      db().appUrl,
      "SELECT state, conflict FROM rfis WHERE business_id = $1 ORDER BY conflict",
      [businessId],
    );
    expect(rows.map((r) => r.conflict)).toEqual([false, true]);
    expect(rows.map((r) => r.state)).toEqual(["DRAFTING", "ACTION_REQUIRED"]);
    expect(
      await query(db().appUrl, "SELECT 1 FROM outbox_jobs WHERE kind = 'rfi.draft'"),
    ).toHaveLength(1);
    const audit = await query(
      db().appUrl,
      "SELECT 1 FROM audit_log WHERE action = 'rfi.conflict' AND business_id = $1",
      [businessId],
    );
    expect(audit).toHaveLength(1);
  });

  it("RFIs for different sources, or without sources, coexist (observed in M0-04)", async () => {
    const { accountId } = await newBusiness(db().app.db);
    const h = rfiHarness(db().app.db, { workers: 2 });
    const a = uid("e6e6e6e6");
    const b = uid("e7e7e7e7");
    const none = uid("e8e8e8e8");
    h.current.set(
      a,
      retarget(fixtureRfi("rfi-check1-fetch"), { id: a, accountId, transferId: uid("f9f9f9f9") }),
    );
    h.current.set(
      b,
      retarget(fixtureRfi("rfi-check1-fetch"), { id: b, accountId, transferId: uid("f8f8f8f8") }),
    );
    h.current.set(
      none,
      retarget(fixtureRfi("rfi-check1-fetch"), { id: none, accountId, sources: [] }),
    );
    await Promise.all([a, b, none].map((id) => post(rfiEventBody(id))));
    await h.drain();
    const rows = await query<{ conflict: boolean; state: string }>(
      db().appUrl,
      "SELECT conflict, state FROM rfis",
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => !r.conflict && r.state === "DRAFTING")).toBe(true);
    expect(
      await query(db().appUrl, "SELECT 1 FROM outbox_jobs WHERE kind = 'rfi.draft'"),
    ).toHaveLength(3);
  });
});
