// M1-09: the SLO query against seeded rows of known latencies. Expected percentiles are computed by
// hand from Postgres' percentile_cont definition (linear interpolation between ranks).
import { randomUUID } from "node:crypto";
import { newRequestId } from "@carnet/domain";
import { beforeEach, describe, expect, it } from "vitest";
import {
  appendAudit,
  createAttempt,
  createBusiness,
  getSloSummary,
  recordWorkerHeartbeat,
  repoCtx,
  SLO_TARGETS,
  sloBreaches,
  updateAttemptStatus,
} from "../src/index";
import { useTestDatabase, withClient } from "./harness";

const db = useTestDatabase();
const NOW = new Date("2026-11-04T12:00:00.000Z");

const exec = (sql: string, params: unknown[] = []) =>
  withClient(db().appUrl, (c) => c.query(sql, params));

beforeEach(async () => {
  await exec("DELETE FROM webhook_events");
  await exec("DELETE FROM outbox_jobs");
  await exec("DELETE FROM worker_heartbeats");
});

/** One acknowledged event received `agoMs` before NOW, acknowledged `latencyMs` later. */
async function seedEvent(latencyMs: number, agoMs = 60_000): Promise<void> {
  const received = new Date(NOW.getTime() - agoMs);
  await exec(
    `INSERT INTO webhook_events (provider_event_id, name, raw_body, signature_ok, received_at, acked_at)
     VALUES ($1, 'payout.transfer.paid', '{}', true, $2, $3)`,
    [randomUUID(), received, new Date(received.getTime() + latencyMs)],
  );
}

async function seedJob(input: {
  kind?: string;
  status: string;
  attempts?: number;
  waitMs: number;
  runMs: number;
  agoMs?: number;
}): Promise<void> {
  const created = new Date(NOW.getTime() - (input.agoMs ?? 60_000));
  const locked = new Date(created.getTime() + input.waitMs);
  const finished = new Date(locked.getTime() + input.runMs);
  await exec(
    `INSERT INTO outbox_jobs (kind, payload, status, attempts, created_at, run_after, locked_at, finished_at)
     VALUES ($1, '{}', $2, $3, $4, $4, $5, $6)`,
    [input.kind ?? "transfer.sync", input.status, input.attempts ?? 1, created, locked, finished],
  );
}

describe("webhook ack latency", () => {
  it("p50 and p95 over 100 events of 1..100 ms are 50.5 and 95.05 ms (percentile_cont)", async () => {
    for (let ms = 1; ms <= 100; ms += 1) await seedEvent(ms);
    // Outside the window or not yet acknowledged: ignored.
    await seedEvent(10_000, 25 * 60 * 60 * 1000);
    await exec(
      `INSERT INTO webhook_events (provider_event_id, name, raw_body, signature_ok, received_at)
       VALUES ('evt_unacked', 'x', '{}', true, $1)`,
      [new Date(NOW.getTime() - 1000)],
    );

    const s = await getSloSummary(db().app.db, { now: NOW });
    expect(s.webhookAck.samples).toBe(100);
    expect(s.webhookAck.p50Ms).toBeCloseTo(50.5, 6);
    expect(s.webhookAck.p95Ms).toBeCloseTo(95.05, 6);
    expect(s.webhookAck.meets).toBe(true);
    expect(s.webhookAck.verdict).toBe("meets");
    expect(sloBreaches(s)).not.toContain("webhook_ack_p95");
  });

  it("a p95 over the 300 ms target misses and is a breach", async () => {
    for (const ms of [100, 200, 400, 500]) await seedEvent(ms);
    // percentile_cont(0.95) of [100,200,400,500]: rank 0.95*3 = 2.85 -> 400 + 0.85*100 = 485
    const s = await getSloSummary(db().app.db, { now: NOW });
    expect(s.webhookAck.p95Ms).toBeCloseTo(485, 6);
    expect(s.webhookAck.verdict).toBe("misses");
    expect(s.webhookAck.targetP95Ms).toBe(SLO_TARGETS.webhookAckP95Ms);
    expect(sloBreaches(s)).toContain("webhook_ack_p95");
  });

  it("an empty table reports no data (null, 0 samples), never 0 ms or a pass", async () => {
    const s = await getSloSummary(db().app.db, { now: NOW });
    expect(s.webhookAck).toMatchObject({
      p50Ms: null,
      p95Ms: null,
      samples: 0,
      meets: null,
      verdict: "no_data",
    });
    expect(s.jobQueue).toEqual({ p50Ms: null, p95Ms: null, samples: 0 });
    expect(s.jobProcessing).toEqual({ p50Ms: null, p95Ms: null, samples: 0 });
    expect(s.workerHeartbeat.lastAt).toBeNull();
    expect(s.reconcile.lastAt).toBeNull();
    expect(sloBreaches(s)).toEqual(["worker_heartbeat_stale", "reconcile_stale"]);
  });
});

describe("jobs, heartbeat, reconcile", () => {
  it("computes queue wait, processing time, depth and DEAD counts", async () => {
    await seedJob({ status: "DONE", waitMs: 10, runMs: 100 });
    await seedJob({ status: "DONE", waitMs: 30, runMs: 300 });
    // Retried: counts for processing time, not for queue wait.
    await seedJob({ status: "DONE", attempts: 3, waitMs: 9_000, runMs: 200 });
    await seedJob({ status: "DEAD", attempts: 8, waitMs: 5, runMs: 5 });
    await seedJob({ status: "DEAD", attempts: 8, waitMs: 5, runMs: 5, agoMs: 3 * 86_400_000 });
    await exec(
      "INSERT INTO outbox_jobs (kind, payload, status) VALUES ('a','{}','PENDING'), ('b','{}','RETRY')",
    );

    const s = await getSloSummary(db().app.db, { now: NOW });
    expect(s.jobQueue.samples).toBe(2);
    expect(s.jobQueue.p50Ms).toBeCloseTo(20, 6);
    expect(s.jobQueue.p95Ms).toBeCloseTo(29, 6); // 10 + 0.95*20
    expect(s.jobProcessing.samples).toBe(3);
    expect(s.jobProcessing.p50Ms).toBeCloseTo(200, 6);
    expect(s.jobProcessing.p95Ms).toBeCloseTo(290, 6); // [100,200,300]: 200 + 0.9*100
    expect(s.queueDepth).toBe(2);
    expect(s.deadJobs).toEqual({ total: 2, inWindow: 1 });
    expect(sloBreaches(s)).toContain("dead_jobs");
  });

  it("reports heartbeat and last reconcile ages", async () => {
    await recordWorkerHeartbeat(db().app.db, "host:1");
    await exec("UPDATE worker_heartbeats SET beat_at = $1", [new Date(NOW.getTime() - 20_000)]);
    await seedJob({ kind: "reconcile", status: "DONE", waitMs: 0, runMs: 1000, agoMs: 61_000 });

    const s = await getSloSummary(db().app.db, { now: NOW });
    expect(s.workerHeartbeat.ageMs).toBe(20_000);
    expect(s.reconcile.ageMs).toBe(60_000);
    expect(sloBreaches(s)).toEqual([]);

    const later = await getSloSummary(db().app.db, { now: new Date(NOW.getTime() + 600_000) });
    expect(sloBreaches(later)).toEqual(["worker_heartbeat_stale", "reconcile_stale"]);
  });

  it("recordWorkerHeartbeat upserts one row per worker", async () => {
    await recordWorkerHeartbeat(db().app.db, "host:1");
    await recordWorkerHeartbeat(db().app.db, "host:1");
    const rows = await exec("SELECT worker_id FROM worker_heartbeats");
    expect(rows.rowCount).toBe(1);
  });
});

describe("tenant figures", () => {
  it("counts PAID-then-FAILED incidents and UNKNOWN attempts, scoped to a business when given", async () => {
    const a = await createBusiness(db().app.db, { name: "A" });
    const b = await createBusiness(db().app.db, { name: "B" });
    for (const id of [a, b]) {
      const ctx = repoCtx(db().app.db, id);
      await appendAudit(ctx, {
        actorType: "system",
        action: "incident.paid_then_failed",
        subject: "payment:x",
      });
      const attempt = await createAttempt(ctx, {
        kind: "transfer",
        refId: randomUUID(),
        requestId: newRequestId(),
      });
      await updateAttemptStatus(ctx, attempt.id, "UNKNOWN");
    }
    const all = await getSloSummary(db().app.db);
    expect(all.incidents).toBeGreaterThanOrEqual(2);
    const scoped = await getSloSummary(db().app.db, { businessId: a });
    expect(scoped.incidents).toBe(1);
    expect(scoped.unknownAttempts).toBe(1);
  });
});
