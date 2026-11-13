// M4-02: with the Airwallex breaker OPEN (derived from failed jobs in the database) the worker defers
// a job that calls Airwallex with a jittered delay and spends no attempt, while the reconciler still
// runs (it only looks things up). Once a job succeeds the breaker closes and the deferred job runs.
import { enqueueJob, getJob } from "@carnet/db";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryLogger } from "../../src/server/log";
import { createRegistry, registerHandler } from "../../src/worker/handlers/index";
import { createWorker } from "../../src/worker/loop";
import { FetchStub, makeClient, query, webTestDatabase } from "../support";

const db = webTestDatabase();
const airwallex = makeClient(new FetchStub());
const BREAKER = { failureThreshold: 3, windowMs: 5 * 60_000, coolDownMs: 60_000 };

beforeEach(async () => {
  await query(db().appUrl, "DELETE FROM outbox_jobs");
  await query(db().appUrl, "UPDATE system_flags SET execution_enabled = true");
});

async function seedFailures(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await query(
      db().appUrl,
      `INSERT INTO outbox_jobs (kind, payload, status, attempts, locked_at, last_error)
       VALUES ('rfi.sync', '{}', 'RETRY', 1, now() - interval '5 seconds', 'boom')`,
    );
  }
  // RETRY rows are due only later; make them not claimable by the worker under test.
  await query(db().appUrl, "UPDATE outbox_jobs SET run_after = now() + interval '1 hour'");
}

describe("circuit breaker in the worker loop", () => {
  it("OPEN: a dependency job is deferred (no attempt spent), the reconciler still runs", async () => {
    await seedFailures(3);
    const ran: string[] = [];
    const registry = createRegistry();
    registerHandler(registry, "transfer.sync", async () => void ran.push("sync"));
    registerHandler(registry, "reconcile", async () => void ran.push("reconcile"));
    const worker = createWorker({
      db: db().app.db,
      registry,
      airwallex,
      logger: memoryLogger(),
      reconcileEveryMs: null,
      breaker: BREAKER,
      random: () => 0.5,
    });
    const syncId = await enqueueJob(db().app.db, { kind: "transfer.sync", payload: {} });
    const first = await worker.tick();
    expect(first?.outcome).toBe("deferred");
    const job = await getJob(db().app.db, syncId);
    expect(job?.status).toBe("PENDING");
    expect(job?.attempts).toBe(0);
    expect(job?.lastError).toContain("airwallex circuit breaker open");
    // The cool-down (up to 60 s) plus up to 50% jitter.
    expect(job?.runAfter.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect(ran).toEqual([]);

    await enqueueJob(db().app.db, { kind: "reconcile", payload: {} });
    expect((await worker.tick())?.outcome).toBe("done");
    expect(ran).toEqual(["reconcile"]);
  });

  it("closes again after a job succeeds; the deferred job then runs", async () => {
    await seedFailures(3);
    const ran: string[] = [];
    const registry = createRegistry();
    registerHandler(registry, "transfer.sync", async () => void ran.push("sync"));
    const worker = createWorker({
      db: db().app.db,
      registry,
      airwallex,
      logger: memoryLogger(),
      reconcileEveryMs: null,
      breaker: BREAKER,
    });
    const syncId = await enqueueJob(db().app.db, { kind: "transfer.sync", payload: {} });
    expect((await worker.tick())?.outcome).toBe("deferred");
    // A success lands after the last failure (what another worker's finished job would write).
    await query(
      db().appUrl,
      `INSERT INTO outbox_jobs (kind, payload, status, attempts, locked_at, finished_at)
       VALUES ('rfi.sync', '{}', 'DONE', 1, now(), now())`,
    );
    await query(db().appUrl, "UPDATE outbox_jobs SET run_after = now() WHERE id = $1", [syncId]);
    expect((await worker.tick())?.outcome).toBe("done");
    expect(ran).toEqual(["sync"]);
  });
});
