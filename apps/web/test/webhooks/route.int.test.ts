// POST /api/webhooks/airwallex against Docker Postgres, replaying the M0-05 recorded deliveries
// re-signed with a test secret (AC 1-3).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../../src/app/api/webhooks/airwallex/route";
import { closeAppDb } from "../../src/server/db";
import { memoryLogger } from "../../src/server/log";
import { setWebhookLogger } from "../../src/server/webhooks/airwallex";
import {
  delivery,
  query,
  recordedDeliveries,
  signedHeaders,
  TEST_WEBHOOK_SECRET,
  webhookRequest,
  webTestDatabase,
} from "../support";

const db = webTestDatabase();

beforeAll(() => {
  // The route reads its configuration from the environment, like production.
  process.env.DATABASE_URL = db().appUrl;
  process.env.AIRWALLEX_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
});
afterAll(async () => {
  await closeAppDb();
});

async function counts(): Promise<{ events: number; jobs: number }> {
  const [row] = await query<{ events: string; jobs: string }>(
    db().appUrl,
    "SELECT (SELECT count(*) FROM webhook_events) AS events, (SELECT count(*) FROM outbox_jobs) AS jobs",
  );
  return { events: Number(row?.events), jobs: Number(row?.jobs) };
}

beforeEach(async () => {
  await query(db().appUrl, "DELETE FROM outbox_jobs");
  await query(db().appUrl, "DELETE FROM webhook_events");
});

describe("AC1: replaying the recorded deliveries", () => {
  it("returns 200 and stores one event row and one job per distinct event id", async () => {
    const deliveries = recordedDeliveries();
    expect(deliveries).toHaveLength(25);
    const distinct = new Set(deliveries.map((d) => d.event.id));
    expect(distinct.size).toBe(23); // paid.1 and rfi.closed.1 were each redelivered once

    for (const d of deliveries) {
      const res = await POST(webhookRequest(d.body, signedHeaders(d.body)));
      expect(res.status, d.file).toBe(200);
      expect(await res.json()).toMatchObject({ received: true });
    }

    expect(await counts()).toEqual({ events: 23, jobs: 23 });
    const rows = await query<{
      provider_event_id: string;
      raw_body: string;
      signature_ok: boolean;
    }>(db().appUrl, "SELECT provider_event_id, raw_body, signature_ok FROM webhook_events");
    expect(new Set(rows.map((r) => r.provider_event_id))).toEqual(distinct);
    // The raw body is stored byte for byte, and only verified events are stored.
    for (const r of rows) {
      expect(deliveries.some((d) => d.body === r.raw_body)).toBe(true);
      expect(r.signature_ok).toBe(true);
    }
    // One job per event, of the right kind, carrying ids only (never the payload status).
    const jobs = await query<{ kind: string; payload: Record<string, string> }>(
      db().appUrl,
      "SELECT kind, payload FROM outbox_jobs",
    );
    const kinds = jobs.map((j) => j.kind).sort();
    // 3 rfi.* events; 20 payout.transfer.* events (including the 9 funding events)
    expect(kinds.filter((k) => k === "rfi.sync")).toHaveLength(3);
    expect(kinds.filter((k) => k === "transfer.sync")).toHaveLength(20);
    for (const j of jobs) {
      expect(Object.keys(j.payload).sort()).toEqual(
        j.kind === "rfi.sync" ? ["rfiId", "webhookEventId"] : ["transferId", "webhookEventId"],
      );
    }
  });
});

describe("AC2: duplicate deliveries", () => {
  it("5 posts of the same event, sequential and concurrent, leave one event and one job", async () => {
    const d = delivery("payout.transfer.sent.1");
    const sequential = [];
    for (let i = 0; i < 2; i++) {
      sequential.push(await POST(webhookRequest(d.body, signedHeaders(d.body))));
    }
    const concurrent = await Promise.all(
      [0, 1, 2].map(() => POST(webhookRequest(d.body, signedHeaders(d.body)))),
    );
    const all = [...sequential, ...concurrent];
    expect(all.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const bodies = await Promise.all(all.map((r) => r.json()));
    expect(bodies.filter((b) => b.duplicate === false)).toHaveLength(1);
    expect(await counts()).toEqual({ events: 1, jobs: 1 });
  });

  it("5 concurrent first deliveries of one event race to exactly one row", async () => {
    const d = delivery("rfi.action_required.1");
    const res = await Promise.all(
      [0, 1, 2, 3, 4].map(() => POST(webhookRequest(d.body, signedHeaders(d.body)))),
    );
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await counts()).toEqual({ events: 1, jobs: 1 });
  });
});

describe("AC3: rejected deliveries", () => {
  let log = memoryLogger();
  beforeEach(() => {
    log = memoryLogger();
    setWebhookLogger(log);
  });
  afterEach(() => {
    setWebhookLogger(null);
  });

  const d = () => delivery("payout.transfer.paid.1");

  it("a tampered body returns 401 and stores nothing", async () => {
    const headers = signedHeaders(d().body);
    const tampered = d().body.replace('"status":"PAID"', '"status":"FAILED"');
    expect(tampered).not.toBe(d().body);
    const res = await POST(webhookRequest(tampered, headers));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
    expect(await counts()).toEqual({ events: 0, jobs: 0 });
  });

  it("a wrong secret returns 401 and stores nothing", async () => {
    const res = await POST(
      webhookRequest(d().body, signedHeaders(d().body, { secret: "some-other-secret" })),
    );
    expect(res.status).toBe(401);
    expect(await counts()).toEqual({ events: 0, jobs: 0 });
  });

  it("a 6-minute-old timestamp returns 401 and stores nothing", async () => {
    const res = await POST(
      webhookRequest(
        d().body,
        signedHeaders(d().body, { timestampMs: Date.now() - 6 * 60 * 1000 }),
      ),
    );
    expect(res.status).toBe(401);
    expect(await counts()).toEqual({ events: 0, jobs: 0 });
  });

  it("the recorded delivery as received (real secret, old timestamp) returns 401", async () => {
    const raw = recordedDeliveries().find((x) => x.file === "payout.transfer.paid.1.json");
    if (!raw) throw new Error("fixture missing");
    const res = await POST(
      webhookRequest(raw.body, { "x-timestamp": "1793772358136", "x-signature": "0".repeat(64) }),
    );
    expect(res.status).toBe(401);
    expect(await counts()).toEqual({ events: 0, jobs: 0 });
  });

  it("every rejection is counted in a log line", async () => {
    await POST(webhookRequest(d().body, signedHeaders(d().body, { secret: "x" })));
    await POST(webhookRequest(d().body, signedHeaders(d().body, { secret: "y" })));
    const lines = log.lines.filter((l) => l.obj.event === "webhook_rejected").map((l) => l.obj);
    expect(log.lines.filter((l) => l.obj.event === "webhook_rejected").map((l) => l.level)).toEqual(
      ["warn", "warn"],
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]?.reason).toBe("bad_signature");
    expect(Number(lines[1]?.rejectedTotal)).toBe(Number(lines[0]?.rejectedTotal) + 1);
    // No secret, signature or body in the line.
    expect(JSON.stringify(lines)).not.toContain(TEST_WEBHOOK_SECRET);
    expect(JSON.stringify(lines)).not.toContain("acct_");
  });

  it("a signed body that is not an event returns 400 and stores nothing", async () => {
    const body = '{"hello":"world"}';
    const res = await POST(webhookRequest(body, signedHeaders(body)));
    expect(res.status).toBe(400);
    expect(await counts()).toEqual({ events: 0, jobs: 0 });
  });

  it("an unconfigured secret returns 503", async () => {
    const saved = process.env.AIRWALLEX_WEBHOOK_SECRET;
    delete process.env.AIRWALLEX_WEBHOOK_SECRET;
    try {
      const res = await POST(webhookRequest(d().body, signedHeaders(d().body)));
      expect(res.status).toBe(503);
    } finally {
      process.env.AIRWALLEX_WEBHOOK_SECRET = saved;
    }
    expect(await counts()).toEqual({ events: 0, jobs: 0 });
  });
});
