// Webhook route rate limit (M1-10 AC 6): RATE_LIMIT_WEBHOOK_PER_MIN (default 600) per minute per
// source IP, in front of signature verification. A burst of 100 valid-signature events within a minute
// is all accepted; from one IP the 601st request in a minute is 429. Date is pinned so the burst
// cannot straddle a window boundary (the limiter, the signer and the verifier all read it).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../src/app/api/webhooks/airwallex/route";
import { DEFAULT_WEBHOOK_PER_MIN, webhookRateLimit } from "../../src/lib/ratelimit";
import { closeAppDb } from "../../src/server/db";
import { memoryLogger } from "../../src/server/log";
import { setWebhookLogger } from "../../src/server/webhooks/airwallex";
import {
  delivery,
  query,
  signedHeaders,
  TEST_WEBHOOK_SECRET,
  webhookRequest,
  webTestDatabase,
} from "../support";

const db = webTestDatabase();

beforeAll(() => {
  process.env.DATABASE_URL = db().appUrl;
  process.env.AIRWALLEX_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  delete process.env.RATE_LIMIT_WEBHOOK_PER_MIN;
  setWebhookLogger(memoryLogger());
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterAll(async () => {
  vi.useRealTimers();
  setWebhookLogger(null);
  await closeAppDb();
});
beforeEach(async () => {
  await query(db().appUrl, "DELETE FROM rate_limits");
});

function fromIp(req: Request, ip: string): Request {
  req.headers.set("x-forwarded-for", ip);
  return req;
}

/** A recorded delivery re-keyed to a new event id and re-signed: a distinct valid event. */
function freshEvent(): string {
  const event = { ...delivery("payout.transfer.paid.1").event, id: randomUUID() };
  return JSON.stringify(event);
}

async function inBatches(n: number, make: (i: number) => Request): Promise<number[]> {
  const statuses: number[] = [];
  for (let start = 0; start < n; start += 25) {
    const batch = Array.from({ length: Math.min(25, n - start) }, (_, k) => POST(make(start + k)));
    statuses.push(...(await Promise.all(batch)).map((r) => r.status));
  }
  return statuses;
}

describe("webhook rate limit", () => {
  it("defaults to 600 per minute and reads RATE_LIMIT_WEBHOOK_PER_MIN", () => {
    expect(DEFAULT_WEBHOOK_PER_MIN).toBe(600);
    expect(webhookRateLimit({})).toEqual({ limit: 600, windowMs: 60_000 });
    expect(webhookRateLimit({ RATE_LIMIT_WEBHOOK_PER_MIN: "900" }).limit).toBe(900);
    expect(webhookRateLimit({ RATE_LIMIT_WEBHOOK_PER_MIN: "nope" }).limit).toBe(600);
  });

  it("accepts a burst of 100 valid-signature events within one minute from one source", async () => {
    vi.setSystemTime(new Date("2026-11-04T10:00:01.000Z"));
    await query(db().appUrl, "DELETE FROM outbox_jobs");
    await query(db().appUrl, "DELETE FROM webhook_events");
    const statuses = await inBatches(100, () => {
      const body = freshEvent();
      return fromIp(webhookRequest(body, signedHeaders(body)), "198.51.100.7");
    });
    expect(statuses.filter((s) => s === 200)).toHaveLength(100);
    const [row] = await query<{ n: string }>(
      db().appUrl,
      "SELECT count(*) AS n FROM webhook_events",
    );
    expect(Number(row?.n)).toBe(100);
  });

  it("601 requests from one IP within a minute: the first 600 pass the limiter, then 429", async () => {
    vi.setSystemTime(new Date("2026-11-04T10:05:10.000Z"));
    // Unsigned requests: cheap, and the limiter runs before verification (they would be 401).
    const statuses = await inBatches(600, () =>
      fromIp(webhookRequest("{}", { "content-type": "application/json" }), "203.0.113.66"),
    );
    expect(statuses.every((s) => s === 401)).toBe(true);
    const res = await POST(
      fromIp(webhookRequest("{}", { "content-type": "application/json" }), "203.0.113.66"),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("50");
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
    // Even a valid signature is refused from that IP for the rest of the window...
    const body = freshEvent();
    expect(
      (await POST(fromIp(webhookRequest(body, signedHeaders(body)), "203.0.113.66"))).status,
    ).toBe(429);
    // ...while another source is unaffected, and the next window starts from zero.
    expect(
      (await POST(fromIp(webhookRequest(body, signedHeaders(body)), "203.0.113.67"))).status,
    ).toBe(200);
    vi.setSystemTime(new Date("2026-11-04T10:06:00.000Z"));
    const again = freshEvent();
    expect(
      (await POST(fromIp(webhookRequest(again, signedHeaders(again)), "203.0.113.66"))).status,
    ).toBe(200);
  });
});
