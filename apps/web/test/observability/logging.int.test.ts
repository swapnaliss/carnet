// AC1: every log line from web and worker is JSON with time, level, msg and request_id or job_id.
// AC4: a fixture webhook produces route and worker lines that share one event_id.
// The route and the worker run with the production pino config writing into a buffer; the worker
// fetches from recorded responses (no network).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../../src/app/api/webhooks/airwallex/route";
import { closeAppDb } from "../../src/server/db";
import { setWebhookLogger } from "../../src/server/webhooks/airwallex";
import { createWorker } from "../../src/worker/loop";
import { defaultRegistry } from "../../src/worker/run";
import {
  blockedCalls,
  delivery,
  FetchStub,
  makeClient,
  query,
  recordedRfi,
  seedPayment,
  signedHeaders,
  TEST_WEBHOOK_SECRET,
  transferRoute,
  webhookRequest,
  webTestDatabase,
} from "../support";
import { type Captured, capture, capturedLogger } from "./capture";

const db = webTestDatabase();

beforeAll(() => {
  process.env.DATABASE_URL = db().appUrl;
  process.env.AIRWALLEX_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
});
afterAll(async () => {
  setWebhookLogger(null);
  await closeAppDb();
  expect(blockedCalls).toEqual([]);
});
beforeEach(async () => {
  await query(db().appUrl, "DELETE FROM outbox_jobs");
  await query(db().appUrl, "DELETE FROM webhook_events");
});

function stub(): FetchStub {
  const s = new FetchStub();
  transferRoute(s, (id) => ({
    ...(delivery("payout.transfer.paid.1").event.data as Record<string, unknown>),
    id,
  }));
  s.on("GET", /^\/api\/v1\/rfis\/[^/]+$/, (call) =>
    Response.json(recordedRfi(call.path.split("/").pop() ?? "")),
  );
  return s;
}

function setup(): { web: Captured; worker: Captured; run: ReturnType<typeof createWorker> } {
  const web = capture();
  const worker = capture();
  setWebhookLogger(capturedLogger(web, { process: "web", route: "webhooks.airwallex" }));
  const run = createWorker({
    db: db().app.db,
    registry: defaultRegistry(),
    airwallex: makeClient(stub()),
    logger: capturedLogger(worker, { process: "worker" }),
    reconcileEveryMs: 50,
    heartbeatMs: 50,
    pollMs: 10,
  });
  return { web, worker, run };
}

async function post(file: string, requestId?: string): Promise<Response> {
  const body = delivery(file).body;
  const headers = signedHeaders(body);
  return POST(
    webhookRequest(body, requestId ? { ...headers, "x-request-id": requestId } : headers),
  );
}

describe("log line format (AC1)", () => {
  it("every captured line from the route and the worker is JSON with time, level, msg and request_id or job_id", async () => {
    const { web, worker, run } = setup();
    const ref = await seedPayment(db().app.db, db().appUrl);
    expect(ref.paymentId).toBeTruthy();
    for (const f of ["rfi.action_required.1", "payout.transfer.paid.1", "rfi.closed.1"]) {
      expect((await post(f)).status).toBe(200);
    }
    expect((await post("rfi.closed.1")).status).toBe(200); // duplicate
    // A rejected delivery logs too.
    const bad = await POST(
      webhookRequest("{}", { "x-timestamp": String(Date.now()), "x-signature": "00" }),
    );
    expect(bad.status).toBe(401);

    // The full loop: start line, heartbeat (stored), reconcile, every job, stop line.
    const loop = run.run();
    for (let i = 0; i < 200 && run.stats.processed < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    run.stop();
    await loop;
    expect(run.stats.processed).toBeGreaterThanOrEqual(4);

    const raw = [...web.raw, ...worker.raw].flatMap((c) => c.split("\n").filter(Boolean));
    expect(raw.length).toBeGreaterThan(10);
    for (const text of raw) {
      const line = JSON.parse(text) as Record<string, unknown>;
      expect(typeof line.time, text).toBe("string");
      expect(Number.isNaN(Date.parse(String(line.time))), text).toBe(false);
      expect(typeof line.level, text).toBe("number");
      expect(typeof line.msg, text).toBe("string");
      expect(Boolean(line.request_id || line.job_id), text).toBe(true);
    }
    // Lines outside any request or job carry the process id; job lines carry job_id.
    const lines = worker.lines();
    expect(lines.find((l) => l.msg === "worker started")?.request_id).toMatch(/^process:/);
    expect(lines.some((l) => typeof l.job_id === "string")).toBe(true);
    const beats = await query(db().appUrl, "SELECT worker_id FROM worker_heartbeats");
    expect(beats.length).toBeGreaterThan(0);
  });
});

describe("event correlation (AC4)", () => {
  it("the route's lines and the worker handler's lines share the event_id", async () => {
    const { web, worker, run } = setup();
    const event = delivery("rfi.action_required.1").event;
    const res = await post("rfi.action_required.1", "trace-ac4-0001");
    expect(res.status).toBe(200);
    while (await run.tick()) {
      /* drain */
    }

    const routeLines = web.lines().filter((l) => l.event_id === event.id);
    const workerLines = worker.lines().filter((l) => l.event_id === event.id);
    expect(routeLines.length).toBeGreaterThan(0);
    expect(workerLines.length).toBeGreaterThan(0);
    // Join: the route line carries the request id, the worker's carry the job id and the RFI id.
    expect(routeLines.every((l) => l.request_id === "trace-ac4-0001")).toBe(true);
    const [job] = await query<{ id: string; payload: { providerEventId: string } }>(
      db().appUrl,
      "SELECT id, payload FROM outbox_jobs",
    );
    expect(job?.payload.providerEventId).toBe(event.id);
    expect(workerLines.every((l) => l.job_id === job?.id && l.job_kind === "rfi.sync")).toBe(true);
    expect(workerLines.some((l) => l.rfi_id === event.data.id)).toBe(true);
  });
});
