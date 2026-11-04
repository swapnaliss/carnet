// The worker loop against Docker Postgres: SKIP LOCKED claims (AC 4), retry with backoff and DEAD
// (AC 5), the kill switch (AC 10) and the self-enqueued reconcile job.
import { createDbClient, type DbClient, enqueueJob, enqueueSingletonJob, getJob } from "@carnet/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { memoryLogger } from "../../src/server/log";
import {
  createRegistry,
  type HandlerRegistry,
  registerHandler,
} from "../../src/worker/handlers/index";
import { createWorker } from "../../src/worker/loop";
import { FetchStub, makeClient, query, webTestDatabase } from "../support";

const db = webTestDatabase();
const airwallex = makeClient(new FetchStub());

const clients: DbClient[] = [];
beforeAll(() => {
  // Two independent pools, as two worker processes would have.
  clients.push(createDbClient(db().appUrl, { max: 2 }), createDbClient(db().appUrl, { max: 2 }));
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
});
beforeEach(async () => {
  await query(db().appUrl, "DELETE FROM outbox_jobs");
  await query(db().appUrl, "UPDATE system_flags SET execution_enabled = true");
});

const tick = () => new Promise((r) => setTimeout(r, 1 + Math.floor(Math.random() * 3)));

async function untilDrained(appUrl: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    const [row] = await query<{ n: string }>(
      appUrl,
      "SELECT count(*) AS n FROM outbox_jobs WHERE status NOT IN ('DONE', 'DEAD')",
    );
    if (Number(row?.n) === 0) return;
    if (Date.now() - started > timeoutMs) throw new Error("jobs not drained in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("AC4: two worker loops on one database", () => {
  it("never process the same job twice (200 jobs, every side-effect counter is 1)", async () => {
    const counter = new Map<string, number>();
    const byWorker = [0, 0];
    const registryFor = (w: number): HandlerRegistry =>
      registerHandler(createRegistry(), "test.count", async (payload) => {
        const key = (payload as { n: string }).n;
        counter.set(key, (counter.get(key) ?? 0) + 1);
        byWorker[w] = (byWorker[w] ?? 0) + 1;
        await tick(); // keep the job in flight so the other loop races for the next one
      });

    for (let i = 0; i < 200; i++) {
      await enqueueJob(db().app.db, { kind: "test.count", payload: { n: String(i) } });
    }
    const workers = clients.map((c, w) =>
      createWorker({
        db: c.db,
        registry: registryFor(w),
        airwallex,
        logger: memoryLogger(),
        pollMs: 5,
        reconcileEveryMs: null,
      }),
    );
    const runs = workers.map((w) => w.run());
    await untilDrained(db().appUrl);
    for (const w of workers) w.stop();
    await Promise.all(runs);

    expect(counter.size).toBe(200);
    expect([...counter.values()].every((n) => n === 1)).toBe(true);
    // Both loops took part (otherwise the test would prove nothing about concurrency).
    expect(byWorker[0]).toBeGreaterThan(0);
    expect(byWorker[1]).toBeGreaterThan(0);
    expect((byWorker[0] ?? 0) + (byWorker[1] ?? 0)).toBe(200);
    const [done] = await query<{ n: string }>(
      db().appUrl,
      "SELECT count(*) AS n FROM outbox_jobs WHERE status = 'DONE' AND attempts = 1",
    );
    expect(Number(done?.n)).toBe(200);
  });
});

describe("AC5: a handler that throws", () => {
  it("is retried with increasing run_after and becomes DEAD after the limit, keeping the last error", async () => {
    let calls = 0;
    const registry = registerHandler(createRegistry(), "test.fail", async () => {
      calls += 1;
      throw new Error(`boom ${calls}`);
    });
    let clock = Date.parse("2026-11-04T00:00:00Z");
    const worker = createWorker({
      db: db().app.db,
      registry,
      airwallex,
      logger: memoryLogger(),
      maxAttempts: 4,
      reconcileEveryMs: null,
      now: () => clock,
      backoff: (attempt) => 1000 * 2 ** (attempt - 1),
    });
    const id = await enqueueJob(db().app.db, { kind: "test.fail", payload: {} });

    const runAfters: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      // make the job due regardless of the fake clock
      await query(db().appUrl, "UPDATE outbox_jobs SET run_after = now() WHERE id = $1", [id]);
      const result = await worker.tick();
      expect(result?.job.id).toBe(id);
      const job = await getJob(db().app.db, id);
      expect(job?.attempts).toBe(attempt);
      expect(job?.lastError).toBe(`Error: boom ${attempt}`);
      if (attempt < 4) {
        expect(result?.outcome).toBe("retry");
        expect(job?.status).toBe("RETRY");
        runAfters.push((job?.runAfter ?? new Date(0)).getTime() - clock);
      } else {
        expect(result?.outcome).toBe("dead");
        expect(job?.status).toBe("DEAD");
      }
      clock += 1;
    }
    expect(runAfters).toEqual([1000, 2000, 4000]);
    // DEAD is final: nothing is claimed again.
    await query(db().appUrl, "UPDATE outbox_jobs SET run_after = now() WHERE id = $1", [id]);
    expect(await worker.tick()).toBeNull();
    expect(calls).toBe(4);
  });

  it("uses the default jittered backoff: each run_after is later than the previous", async () => {
    const registry = registerHandler(createRegistry(), "test.fail2", async () => {
      throw new Error("always");
    });
    const worker = createWorker({
      db: db().app.db,
      registry,
      airwallex,
      logger: memoryLogger(),
      maxAttempts: 5,
      reconcileEveryMs: null,
    });
    const id = await enqueueJob(db().app.db, { kind: "test.fail2", payload: {} });
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      await query(db().appUrl, "UPDATE outbox_jobs SET run_after = now() WHERE id = $1", [id]);
      const before = Date.now();
      await worker.tick();
      const job = await getJob(db().app.db, id);
      delays.push((job?.runAfter ?? new Date(0)).getTime() - before);
    }
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i] ?? 0).toBeGreaterThan(delays[i - 1] ?? 0);
    }
  });

  it("a job kind with no handler goes straight to DEAD with the reason stored", async () => {
    const worker = createWorker({
      db: db().app.db,
      registry: createRegistry(),
      airwallex,
      logger: memoryLogger(),
      reconcileEveryMs: null,
    });
    const id = await enqueueJob(db().app.db, { kind: "nobody.handles.this", payload: {} });
    expect((await worker.tick())?.outcome).toBe("dead");
    const job = await getJob(db().app.db, id);
    expect(job?.status).toBe("DEAD");
    expect(job?.lastError).toContain("no handler registered");
  });
});

describe("AC10: kill switch", () => {
  it("with execution_enabled=false a mutating job is deferred and a fetch job still runs", async () => {
    await query(db().appUrl, "UPDATE system_flags SET execution_enabled = false");
    const ran: string[] = [];
    const registry = createRegistry();
    registerHandler(registry, "test.mutate", async () => void ran.push("mutate"), {
      mutating: true,
    });
    registerHandler(registry, "test.fetch", async () => void ran.push("fetch"));
    const logger = memoryLogger();
    const worker = createWorker({
      db: db().app.db,
      registry,
      airwallex,
      logger,
      reconcileEveryMs: null,
    });
    const mutateId = await enqueueJob(db().app.db, { kind: "test.mutate", payload: {} });
    const fetchId = await enqueueJob(db().app.db, { kind: "test.fetch", payload: {} });

    const first = await worker.tick();
    const second = await worker.tick();
    expect([first?.outcome, second?.outcome].sort()).toEqual(["deferred", "done"]);
    expect(ran).toEqual(["fetch"]);

    const mutate = await getJob(db().app.db, mutateId);
    expect(mutate?.status).toBe("PENDING");
    expect(mutate?.attempts).toBe(0); // a deferral is not a failed attempt
    expect(mutate?.runAfter.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(mutate?.lastError).toContain("kill switch");
    expect((await getJob(db().app.db, fetchId))?.status).toBe("DONE");
    expect(logger.lines.some((l) => l.msg?.includes("mutating job deferred"))).toBe(true);

    // Switched back on, the deferred job runs once it is due.
    await query(db().appUrl, "UPDATE system_flags SET execution_enabled = true");
    await query(db().appUrl, "UPDATE outbox_jobs SET run_after = now() WHERE id = $1", [mutateId]);
    expect((await worker.tick())?.outcome).toBe("done");
    expect(ran).toEqual(["fetch", "mutate"]);
  });

  it("a missing system_flags row is treated as disabled", async () => {
    const registry = registerHandler(createRegistry(), "test.mutate2", async () => undefined, {
      mutating: true,
    });
    // Simulates the seeded row going missing; restored afterwards.
    const [saved] = await query(db().appUrl, "SELECT * FROM system_flags WHERE id = 1");
    await query(db().appUrl, "DELETE FROM system_flags");
    try {
      const worker = createWorker({
        db: db().app.db,
        registry,
        airwallex,
        logger: memoryLogger(),
        reconcileEveryMs: null,
      });
      await enqueueJob(db().app.db, { kind: "test.mutate2", payload: {} });
      expect((await worker.tick())?.outcome).toBe("deferred");
    } finally {
      const s = saved as Record<string, unknown>;
      await query(
        db().appUrl,
        "INSERT INTO system_flags (id, agents_enabled, execution_enabled, daily_spend_cap_minor, per_run_cap_minor, cap_currency) VALUES (1, $1, true, $2, $3, $4)",
        [s.agents_enabled, s.daily_spend_cap_minor, s.per_run_cap_minor, s.cap_currency],
      );
    }
  });
});

describe("reconcile scheduling", () => {
  it("at most one reconcile job is queued, however many loops race to enqueue it", async () => {
    const attempts = Array.from({ length: 10 }, (_, i) =>
      enqueueSingletonJob((clients[i % 2] as DbClient).db, { kind: "reconcile", payload: {} }),
    );
    const ids = (await Promise.all(attempts)).filter((x) => x !== null);
    expect(ids).toHaveLength(1);
    const [row] = await query<{ n: string }>(
      db().appUrl,
      "SELECT count(*) AS n FROM outbox_jobs WHERE kind = 'reconcile'",
    );
    expect(Number(row?.n)).toBe(1);
  });

  it("the loop enqueues the reconcile job itself and runs it through the registry", async () => {
    let reconciles = 0;
    const registry = registerHandler(createRegistry(), "reconcile", async () => {
      reconciles += 1;
    });
    const worker = createWorker({
      db: db().app.db,
      registry,
      airwallex,
      logger: memoryLogger(),
      pollMs: 5,
      reconcileEveryMs: 60_000,
    });
    const run = worker.run();
    await untilDrained(db().appUrl);
    await new Promise((r) => setTimeout(r, 30));
    worker.stop();
    await run;
    expect(reconciles).toBe(1); // the next one is due 60 s later
  });
});
