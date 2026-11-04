// AC7: /api/ops/slo answers 401 without the header token and the JSON summary with it.
// AC5 (endpoint half): with no webhook events the summary reports "no data", not 0 ms.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeAppDb } from "../../src/server/db";
import { createSloHandler } from "../../src/server/ops";
import { query, webTestDatabase } from "../support";

const db = webTestDatabase();
const TOKEN = "ops_test_token_not_a_secret_0123456789";

afterAll(async () => {
  await closeAppDb();
});
beforeEach(async () => {
  await query(db().appUrl, "DELETE FROM webhook_events");
  await query(db().appUrl, "DELETE FROM outbox_jobs");
  await query(db().appUrl, "DELETE FROM worker_heartbeats");
});

const handler = (env: Record<string, string | undefined> = { OPS_CHECK_TOKEN: TOKEN }) =>
  createSloHandler({ db: () => db().app.db, env });
const get = (headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/ops/slo", { headers });

describe("GET /api/ops/slo", () => {
  it("401 without the token, with a wrong token, or with a non-Bearer scheme", async () => {
    for (const headers of [
      {},
      { authorization: "Bearer wrong" },
      { authorization: `Bearer ${TOKEN}x` },
      { authorization: TOKEN },
      { "x-ops-token": TOKEN },
    ]) {
      const res = await handler()(get(headers));
      expect(res.status, JSON.stringify(headers)).toBe(401);
      const body = (await res.json()) as { error: { code: string; request_id: string } };
      expect(body.error.code).toBe("UNAUTHENTICATED");
      expect(body.error.request_id).toBe(res.headers.get("x-request-id"));
      expect(JSON.stringify(body)).not.toContain("webhookAck");
    }
  });

  it("503 when OPS_CHECK_TOKEN is unset or too short (endpoint off)", async () => {
    expect((await handler({})(get({ authorization: "Bearer " }))).status).toBe(503);
    expect(
      (await handler({ OPS_CHECK_TOKEN: "short" })(get({ authorization: "Bearer short" }))).status,
    ).toBe(503);
  });

  it("200 with the JSON summary; empty tables report no data", async () => {
    const res = await handler()(get({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      status: string;
      breaches: string[];
      summary: Record<string, unknown> & { webhookAck: Record<string, unknown> };
    };
    expect(body.summary.webhookAck).toMatchObject({
      p95Ms: null,
      samples: 0,
      verdict: "no_data",
    });
    // No worker has beaten in this database: the check reports a breach, as it would in production.
    expect(body.status).toBe("breach");
    expect(body.breaches).toEqual(["worker_heartbeat_stale", "reconcile_stale"]);
    expect(Object.keys(body.summary).sort()).toEqual(
      [
        "deadJobs",
        "generatedAt",
        "incidents",
        "jobProcessing",
        "jobQueue",
        "queueDepth",
        "reconcile",
        "unknownAttempts",
        "webhookAck",
        "windowMs",
        "windowStart",
        "workerHeartbeat",
      ].sort(),
    );
  });

  it("ok once the worker and reconciler have reported and acks are fast", async () => {
    await query(db().appUrl, "INSERT INTO worker_heartbeats (worker_id) VALUES ('w:1')");
    await query(
      db().appUrl,
      "INSERT INTO outbox_jobs (kind, payload, status, locked_at, finished_at) VALUES ('reconcile', '{}', 'DONE', now(), now())",
    );
    await query(
      db().appUrl,
      "INSERT INTO webhook_events (provider_event_id, name, raw_body, signature_ok, received_at, acked_at) VALUES ('e1','x','{}',true, now() - interval '40 ms', now())",
    );
    const res = await handler()(get({ authorization: `Bearer ${TOKEN}` }));
    const body = (await res.json()) as {
      status: string;
      summary: { webhookAck: { samples: number } };
    };
    expect(body.status).toBe("ok");
    expect(body.summary.webhookAck.samples).toBe(1);
  });
});
