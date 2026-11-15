// M4-06 load test (`npm run load`). Measures Carnet's webhook path on a LOCAL stack: the production
// Next.js server (`next start`, the built app) receiving signed webhooks over HTTP, worker processes
// running the real loop and handlers, and a local Postgres. Airwallex responses are replayed from
// recorded fixtures (scripts/load/worker.ts); nothing calls Airwallex or the model.
//
//   npm run load -- --profile all --out "$TMPDIR/load.json"   # average, peak, burst (+ burst, 1 worker)
//   npm run load -- --profile burst --workers 1
//   npm run load -- --check-duplicates                        # DB assertions on the last run
//
// Needs: Postgres reachable as DATABASE_MIGRATION_URL / DATABASE_URL (default: the synthetic local
// roles of packages/db/sql/roles.sql on localhost:5432+PORT_OFFSET) and `npm run build -w @carnet/web`.
// Each run recreates the scratch database `carnet_load` (left in place for --check-duplicates).
// The webhook secret and the auth secret are generated per run and only passed to the child processes.
// Exit code: 0 when every configured SLO held, 1 on a breach or a failed check, 2 on a setup error.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { computeWebhookSignature } from "@carnet/airwallex";
import { createBusiness, createDbClient, createPayment, repoCtx, runMigrations } from "@carnet/db";
import { money } from "@carnet/domain";
import pg from "pg";
import { buildPlan, PROFILES, type Profile, type ProfilePlan, replayIndex } from "./plan";

// ---- configuration ---------------------------------------------------------------------------
const SLO_ACK_P95_MS = 300; // docs/architecture.md §9: webhook acknowledged p95 < 300 ms warm
const DRAIN_TIMEOUT_MS = 120_000;
const LOAD_DB = "carnet_load";
const ROOT = resolve(import.meta.dirname, "../..");
const offset = Number(process.env.PORT_OFFSET ?? 0);
const PORT = Number(process.env.LOAD_PORT ?? 3000 + offset);
const BASE = `http://localhost:${PORT}`;
const TMP = process.env.TMPDIR ?? "/tmp";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const profileArg = arg("--profile") ?? "all";
const workersArg = Number(arg("--workers") ?? 3);
const outPath = resolve(arg("--out") ?? join(TMP, "carnet-load.json"));
const storagePayments = Number(arg("--storage-payments") ?? 300);
const seed = Number(arg("--seed") ?? 4606);

function die(message: string, code = 2): never {
  console.error(`load: ${message}`);
  process.exit(code);
}

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
function dbUrl(key: "DATABASE_URL" | "DATABASE_MIGRATION_URL", role: string): URL {
  const raw = process.env[key] ?? `postgres://${role}:${role}@localhost:${5432 + offset}/carnet`;
  const url = new URL(raw);
  if (!LOCAL.has(url.hostname))
    die(`${key} must point at a local Postgres (load tests never run remotely)`);
  return url;
}
const migrationUrl = dbUrl("DATABASE_MIGRATION_URL", "carnet_migrator");
const appBaseUrl = dbUrl("DATABASE_URL", "carnet_app");
const inDb = (u: URL, name: string) => {
  const c = new URL(u.toString());
  c.pathname = `/${name}`;
  return c.toString();
};
const loadAppUrl = inDb(appBaseUrl, LOAD_DB);
const loadMigrationUrl = inDb(migrationUrl, LOAD_DB);

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// ---- statistics ------------------------------------------------------------------------------
function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number;
}
const r1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
function summary(values: number[]) {
  return {
    n: values.length,
    p50: r1(pct(values, 50)),
    p95: r1(pct(values, 95)),
    p99: r1(pct(values, 99)),
    max: r1(values.length ? Math.max(...values) : null),
  };
}

// ---- process sampling (/proc, Linux) ---------------------------------------------------------
const CLK_TCK = 100;
function procTree(pid: number): number[] {
  const out = [pid];
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      const kids = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim();
      for (const k of kids ? kids.split(/\s+/) : []) out.push(...procTree(Number(k)));
    }
  } catch {
    // process gone
  }
  return out;
}
function procSample(pid: number): { cpuS: number; rssBytes: number } {
  let cpuS = 0;
  let rssBytes = 0;
  for (const p of procTree(pid)) {
    try {
      const stat = readFileSync(`/proc/${p}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      cpuS += (Number(fields[11]) + Number(fields[12])) / CLK_TCK;
      const rss = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${p}/status`, "utf8"));
      rssBytes += rss ? Number(rss[1]) * 1024 : 0;
    } catch {
      // exited between listing and reading
    }
  }
  return { cpuS, rssBytes };
}

// ---- children --------------------------------------------------------------------------------
const scratch = join(TMP, `carnet-load-${Date.now()}`);
mkdirSync(scratch, { recursive: true });
const webhookSecret = `whsec_load_${randomBytes(24).toString("hex")}`;
const baseEnv = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  NODE_ENV: "production",
};

async function startWeb(): Promise<ChildProcess> {
  const next = join(ROOT, "node_modules/next/dist/bin/next");
  if (!existsSync(join(ROOT, "apps/web/.next/BUILD_ID")))
    die("run `npm run build -w @carnet/web` first");
  const log = openSync(join(scratch, "web.log"), "a");
  const child = spawn(process.execPath, [next, "start", "--port", String(PORT)], {
    cwd: join(ROOT, "apps/web"),
    env: {
      ...baseEnv,
      PORT: String(PORT),
      DATABASE_URL: loadAppUrl,
      AIRWALLEX_WEBHOOK_SECRET: webhookSecret,
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      BETTER_AUTH_URL: BASE,
      APP_BASE_URL: BASE,
    },
    stdio: ["ignore", log, log],
  });
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (child.exitCode !== null)
      die(`web server exited (${child.exitCode}); see ${scratch}/web.log`);
    try {
      const res = await fetch(`${BASE}/api/webhooks/airwallex`, { method: "POST", body: "{}" });
      if (res.status === 401) return child;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  die(`web server not ready on ${BASE} within 60 s`);
}

function startWorkers(
  count: number,
  indexPath: string,
  tag: string,
): { child: ChildProcess; claims: string }[] {
  return Array.from({ length: count }, (_, i) => {
    const claims = join(scratch, `${tag}-w${i + 1}.claims.json`);
    const log = openSync(join(scratch, `${tag}-w${i + 1}.log`), "a");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(ROOT, "scripts/load/worker.ts")],
      {
        cwd: ROOT,
        env: {
          ...baseEnv,
          DATABASE_URL: loadAppUrl,
          LOAD_INDEX: indexPath,
          LOAD_WORKER_ID: `w${i + 1}`,
          LOAD_CLAIMS_OUT: claims,
        },
        stdio: ["ignore", log, log],
      },
    );
    return { child, claims };
  });
}

async function stopChild(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  if (child.exitCode !== null) return;
  const done = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  await done;
  clearTimeout(t);
}

// ---- data setup ------------------------------------------------------------------------------
async function recreateDatabase(): Promise<void> {
  await withClient(migrationUrl.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${LOAD_DB}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${LOAD_DB}"`);
  });
  await runMigrations(loadMigrationUrl);
}

/** One business and its payments, each linked to its synthetic transfer (as the executor links it). */
async function seedPayments(plan: ProfilePlan, label: string): Promise<void> {
  const db = createDbClient(loadAppUrl, { max: 2 });
  try {
    const businessId = await createBusiness(db.db, { name: `Carnet load test ${label}` });
    const ctx = repoCtx(db.db, businessId);
    await withClient(loadAppUrl, async (c) => {
      for (const p of plan.payments) {
        const payment = await createPayment(ctx, {
          amount: money(250_000n, "USD"),
          sourceCurrency: "USD",
          method: "LOCAL",
          reference: `load ${label} ${p.index}`,
        });
        await c.query("UPDATE payments SET transfer_id = $1 WHERE id = $2", [
          p.transferId,
          payment.id,
        ]);
      }
    });
  } finally {
    await db.close();
  }
}

// ---- delivery --------------------------------------------------------------------------------
interface Sent {
  atMs: number;
  latencyMs: number;
  status: number;
  duplicate: boolean;
  bodyDuplicate: boolean | null;
}

async function deliver(
  body: string,
  sourceIp: string,
): Promise<{ status: number; latencyMs: number; dup: boolean | null }> {
  const ts = String(Date.now());
  const start = performance.now();
  try {
    const res = await fetch(`${BASE}/api/webhooks/airwallex`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-timestamp": ts,
        "x-signature": computeWebhookSignature(webhookSecret, ts, body),
        "x-forwarded-for": sourceIp,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    const latencyMs = performance.now() - start;
    let dup: boolean | null = null;
    try {
      dup = (JSON.parse(text) as { duplicate?: boolean }).duplicate ?? null;
    } catch {
      // error body
    }
    return { status: res.status, latencyMs, dup };
  } catch {
    return { status: 0, latencyMs: performance.now() - start, dup: null };
  }
}

async function queueDepth(c: pg.Client): Promise<number> {
  const r = await c.query(
    "SELECT count(*)::int AS n FROM outbox_jobs WHERE status IN ('PENDING','RETRY','RUNNING')",
  );
  return r.rows[0].n as number;
}

// ---- one profile -----------------------------------------------------------------------------
async function runProfile(
  profile: Profile,
  workers: number,
  tag: string,
  ipOctet: number,
  options: { perPaymentIp?: boolean } = {},
) {
  const plan = buildPlan(profile, { seed: seed + ipOctet });
  await seedPayments(plan, tag);
  const indexPath = join(scratch, `${tag}.index.json`);
  const ws = startWorkers(workers, indexPath, tag);
  // Workers compile and connect first; the clock starts only when every one is ready.
  const readyBy = Date.now() + 60_000;
  while (!ws.every((w) => existsSync(`${w.claims}.ready`))) {
    if (Date.now() > readyBy) throw new Error(`${tag}: workers not ready within 60 s`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const startEpoch = Date.now() + 1_000;
  writeFileSync(indexPath, JSON.stringify(replayIndex(plan, startEpoch)));
  const sourceIp = `198.51.100.${ipOctet}`; // TEST-NET-2: one source address per profile

  const monitor = new pg.Client({ connectionString: loadAppUrl });
  await monitor.connect();
  const depth: { tMs: number; depth: number }[] = [];
  const res: { tMs: number; workerCpuS: number; workerRssBytes: number }[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const tMs = Date.now() - startEpoch;
      depth.push({ tMs, depth: await queueDepth(monitor) });
      let cpuS = 0;
      let rss = 0;
      for (const w of ws) {
        if (w.child.pid) {
          const s = procSample(w.child.pid);
          cpuS += s.cpuS;
          rss += s.rssBytes;
        }
      }
      res.push({ tMs, workerCpuS: cpuS, workerRssBytes: rss });
      await new Promise((r) => setTimeout(r, 500));
    }
  })();

  await new Promise((r) => setTimeout(r, Math.max(0, startEpoch - Date.now())));
  const windowStart = new Date();
  const sent: Sent[] = [];
  const inflight: Promise<void>[] = [];
  for (const d of plan.deliveries) {
    const wait = startEpoch + d.atMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    // Open-loop: fire and keep the schedule; the response is recorded when it arrives.
    inflight.push(
      deliver(
        d.body,
        options.perPaymentIp
          ? `10.${(d.paymentIndex >> 8) & 255}.${d.paymentIndex & 255}.1`
          : sourceIp,
      ).then((r) => {
        sent.push({
          atMs: d.atMs,
          latencyMs: r.latencyMs,
          status: r.status,
          duplicate: d.duplicate,
          bodyDuplicate: r.dup,
        });
      }),
    );
  }
  const lastSendAt = Date.now();
  await Promise.all(inflight);
  const windowEnd = new Date();

  let drainedAt: number | null = null;
  while (Date.now() - lastSendAt < DRAIN_TIMEOUT_MS) {
    if ((await queueDepth(monitor)) === 0) {
      drainedAt = Date.now();
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  sampling = false;
  await sampler;

  // DB: job latency (webhook received -> its job DONE) and server-side ack time, this window only.
  const lat = await monitor.query(
    `SELECT EXTRACT(EPOCH FROM (j.finished_at - e.received_at)) * 1000 AS job_ms,
            EXTRACT(EPOCH FROM (e.acked_at - e.received_at)) * 1000 AS ack_ms,
            j.status, j.attempts, j.kind
       FROM webhook_events e
       JOIN outbox_jobs j ON j.payload->>'webhookEventId' = e.id::text
      WHERE e.received_at >= $1 AND e.received_at <= $2`,
    [windowStart, windowEnd],
  );
  const events = await monitor.query(
    "SELECT count(*)::int AS n FROM webhook_events WHERE received_at >= $1 AND received_at <= $2",
    [windowStart, windowEnd],
  );
  const pays = await monitor.query(
    `SELECT p.transfer_status, count(*)::int AS n FROM payments p JOIN businesses b ON b.id = p.business_id
      WHERE b.name = $1 GROUP BY 1`,
    [`Carnet load test ${tag}`],
  );
  await monitor.end();
  for (const w of ws) await stopChild(w.child);
  const workerReports = ws.map((w) =>
    existsSync(w.claims)
      ? (JSON.parse(readFileSync(w.claims, "utf8")) as {
          worker: string;
          claims: { jobId: string; kind: string }[];
          downstream: Record<string, number>;
          unmatched: string[];
          cpuUserMs: number;
          cpuSystemMs: number;
          maxRssBytes: number;
        })
      : null,
  );

  const claimed = workerReports.flatMap((w) => w?.claims ?? []);
  const seen = new Map<string, number>();
  for (const c of claimed) seen.set(c.jobId, (seen.get(c.jobId) ?? 0) + 1);
  const ranTwice = [...seen.values()].filter((n) => n > 1).length;
  const perWorker = Object.fromEntries(
    workerReports.map((w, i) => [`w${i + 1}`, w?.claims.length ?? null]),
  );
  const ok = sent.filter((s) => s.status === 200);
  const errors = sent.filter((s) => s.status !== 200);
  const ackMs = sent.filter((s) => s.status === 200).map((s) => s.latencyMs);
  const jobRows = lat.rows as {
    job_ms: string | null;
    ack_ms: string | null;
    status: string;
    attempts: number;
  }[];
  const jobMs = jobRows.filter((r) => r.job_ms !== null).map((r) => Number(r.job_ms));
  const serverAck = jobRows.filter((r) => r.ack_ms !== null).map((r) => Number(r.ack_ms));
  const durationS = (lastSendAt - startEpoch) / 1000;
  const paymentStatus = Object.fromEntries(
    (pays.rows as { transfer_status: string | null; n: number }[]).map((r) => [
      String(r.transfer_status),
      r.n,
    ]),
  );
  const peakRss = Math.max(0, ...res.map((r) => r.workerRssBytes));
  const cpuEnd = res.at(-1)?.workerCpuS ?? 0;
  const cpuStart = res[0]?.workerCpuS ?? 0;

  const checks = {
    allAcked: errors.length === 0,
    uniqueEventsStored: (events.rows[0].n as number) === plan.uniqueEvents,
    // Exactly one delivery per event id is answered as new and every other copy as a duplicate (a
    // copy racing its original may be the one stored, so which copy wins is not fixed).
    oneNewAnswerPerEvent:
      sent.filter((s) => s.bodyDuplicate === false).length === plan.uniqueEvents,
    oneJobPerStoredEvent: jobRows.length === plan.uniqueEvents,
    allJobsDoneFirstAttempt: jobRows.every((r) => r.status === "DONE" && r.attempts === 1),
    noJobRanTwice: ranTwice === 0,
    allPaymentsPaid: paymentStatus.PAID === plan.payments.length,
    queueDrained: drainedAt !== null,
    noUnstubbedCalls: workerReports.every((w) => w !== null && w.unmatched.length === 0),
  };
  return {
    profile: profile.name,
    workers,
    rateTarget: profile.rate,
    rateAchieved: Math.round((sent.length / Math.max(durationS, 0.001)) * 100) / 100,
    durationS: Math.round(durationS * 10) / 10,
    payments: plan.payments.length,
    deliveries: sent.length,
    duplicatesSent: sent.filter((s) => s.duplicate).length,
    uniqueEvents: plan.uniqueEvents,
    errors: errors.length,
    errorStatuses: [...new Set(errors.map((e) => e.status))],
    errorRate: sent.length ? errors.length / sent.length : 0,
    ackMs: summary(ackMs),
    ackP50Ms: r1(pct(ackMs, 50)),
    ackP95Ms: r1(pct(ackMs, 95)),
    ackP99Ms: r1(pct(ackMs, 99)),
    serverAckMs: summary(serverAck),
    jobLatencyMs: summary(jobMs),
    drainMsAfterLastSend: drainedAt === null ? null : drainedAt - lastSendAt,
    maxQueueDepth: Math.max(0, ...depth.map((d) => d.depth)),
    queueDepthSeries: depth
      .filter((_, i) => i % 2 === 0)
      .map((d) => [Math.round(d.tMs / 100) / 10, d.depth]),
    workerCpuSeconds: Math.round((cpuEnd - cpuStart) * 100) / 100,
    workerCpuPctOfOneCore:
      Math.round(((cpuEnd - cpuStart) / Math.max((res.at(-1)?.tMs ?? 1) / 1000, 0.001)) * 1000) /
      10,
    workerPeakRssMiB: Math.round(peakRss / 1048576),
    jobsPerWorker: perWorker,
    downstreamNoOpJobs: workerReports.reduce<Record<string, number>>((acc, w) => {
      for (const [k, v] of Object.entries(w?.downstream ?? {})) acc[k] = (acc[k] ?? 0) + v;
      return acc;
    }, {}),
    paymentStatus,
    checks,
    ok: ok.length,
  };
}

// ---- storage ---------------------------------------------------------------------------------
async function tableSizes(): Promise<Record<string, number>> {
  return withClient(loadMigrationUrl, async (c) => {
    await c.query("CHECKPOINT").catch(() => undefined);
    const r = await c.query(
      `SELECT c.relname AS t, pg_total_relation_size(c.oid)::bigint AS b
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname = 'public'`,
    );
    return Object.fromEntries(
      (r.rows as { t: string; b: string }[]).map((x) => [x.t, Number(x.b)]),
    );
  });
}

async function runStorage(workers: number) {
  // A fast open-loop run (50/s) through the same path; latency is not the point here. One source
  // address per payment so the per-IP webhook limit (600/min) does not refuse the sender.
  const rate = 50;
  const profile: Profile = { name: "burst", rate, durationS: (storagePayments * 9 * 1.1) / rate };
  const before = await tableSizes();
  const run = await runProfile(profile, workers, "storage", 200, { perPaymentIp: true });
  const failed = Object.entries(run.checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (failed.length) throw new Error(`storage phase failed checks: ${failed.join(", ")}`);
  const plan = {
    payments: { length: run.payments },
    uniqueEvents: run.uniqueEvents,
    deliveries: { length: run.deliveries },
  };
  const after = await tableSizes();
  const perTable: Record<string, number> = {};
  for (const t of Object.keys(after)) {
    const d = (after[t] ?? 0) - (before[t] ?? 0);
    if (d !== 0) perTable[t] = Math.round(d / plan.payments.length);
  }
  const excluded = new Set(["documents", "rate_limits"]);
  const relational = Object.entries(perTable)
    .filter(([t]) => !excluded.has(t))
    .reduce((a, [, b]) => a + b, 0);
  const docDir = join(ROOT, "fixtures/dataset");
  const docs = readdirSync(docDir)
    .filter((f) => /\.(pdf|png|jpe?g)$/i.test(f))
    .map((f) => statSync(join(docDir, f)).size);
  const docAvg = docs.length ? Math.round(docs.reduce((a, b) => a + b, 0) / docs.length) : null;
  const perDay = 5_000; // architecture §12: 5,000 payments/day at 100x
  return {
    payments: plan.payments.length,
    eventsStored: plan.uniqueEvents,
    deliveries: plan.deliveries.length,
    bytesPerPaymentByTable: perTable,
    bytesPerPaymentRelational: relational,
    excludedFromRelational: [...excluded],
    architectureClaimBytes: 5 * 1024,
    mbPerDayAt100x: Math.round(((relational * perDay) / 1e6) * 10) / 10,
    gbPerYearAt100x: Math.round(((relational * perDay * 365) / 1e9) * 10) / 10,
    documents: {
      note: "documents.bytes measured separately: size of the synthetic dataset files (fixtures/dataset)",
      files: docs.length,
      avgBytes: docAvg,
    },
  };
}

// ---- duplicate check (separate invocation) ---------------------------------------------------
async function checkDuplicates(): Promise<boolean> {
  return withClient(loadAppUrl, async (c) => {
    const q = async (sql: string) => (await c.query(sql)).rows[0] as Record<string, number>;
    const r = {
      webhookEvents: (await q("SELECT count(*)::int AS n FROM webhook_events")).n,
      distinctProviderIds: (
        await q("SELECT count(DISTINCT provider_event_id)::int AS n FROM webhook_events")
      ).n,
      eventsWithoutExactlyOneJob: (
        await q(`SELECT count(*)::int AS n FROM webhook_events e
          WHERE (SELECT count(*) FROM outbox_jobs j WHERE j.payload->>'webhookEventId' = e.id::text) <> 1`)
      ).n,
      jobsNotDone: (await q("SELECT count(*)::int AS n FROM outbox_jobs WHERE status <> 'DONE'")).n,
      jobsClaimedMoreThanOnce: (
        await q("SELECT count(*)::int AS n FROM outbox_jobs WHERE attempts <> 1")
      ).n,
      paymentsNotPaid: (
        await q(
          "SELECT count(*)::int AS n FROM payments WHERE transfer_status IS DISTINCT FROM 'PAID'",
        )
      ).n,
      payments: (await q("SELECT count(*)::int AS n FROM payments")).n,
      rfis: (await q("SELECT count(*)::int AS n FROM rfis")).n,
      rfiDraftJobsPerRfiOverOne: (
        await q(`SELECT count(*)::int AS n FROM (SELECT payload->>'rfiId' FROM outbox_jobs
          WHERE kind = 'rfi.draft' GROUP BY 1 HAVING count(*) > 1) x`)
      ).n,
    };
    console.table(r);
    const ok =
      r.webhookEvents > 0 &&
      r.webhookEvents === r.distinctProviderIds &&
      r.eventsWithoutExactlyOneJob === 0 &&
      r.jobsNotDone === 0 &&
      r.jobsClaimedMoreThanOnce === 0 &&
      r.paymentsNotPaid === 0 &&
      r.rfis === r.payments &&
      r.rfiDraftJobsPerRfiOverOne === 0;
    console.log(ok ? "check-duplicates: PASS (no duplicate effects)" : "check-duplicates: FAIL");
    return ok;
  });
}

// ---- main ------------------------------------------------------------------------------------
async function main(): Promise<number> {
  if (args.includes("--check-duplicates")) return (await checkDuplicates()) ? 0 : 1;
  const names: Profile["name"][] =
    profileArg === "all" ? ["average", "peak", "burst"] : [profileArg as Profile["name"]];
  if (!names.every((n) => n in PROFILES)) die(`unknown --profile ${profileArg}`);

  const commit = await new Promise<string>((r) => {
    const g = spawn("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT });
    let s = "";
    g.stdout.on("data", (b) => {
      s += b;
    });
    g.on("close", () => r(s.trim()));
  });
  const environment = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memGiB: Math.round(totalmem() / 2 ** 30),
    loadAverageAtStart: loadavg().map((n) => Math.round(n * 100) / 100),
    postgres: await withClient(
      migrationUrl.toString(),
      async (c) => (await c.query("SHOW server_version")).rows[0].server_version as string,
    ),
    commit,
    startedAt: new Date().toISOString(),
  };
  await recreateDatabase();
  const web = await startWeb();
  const results: Record<string, unknown> = { environment, sloAckP95Ms: SLO_ACK_P95_MS };
  let breach = false;
  try {
    // Warm-up (not measured): the SLO is "warm"; a cold first request compiles routes and opens pools.
    results.warmup = await runProfile(
      { name: "peak", rate: 5, durationS: 6 },
      workersArg,
      "warmup",
      250,
    );

    const runs: [string, Profile, number][] = names.map((n) => [n, PROFILES[n], workersArg]);
    if (profileArg === "all") runs.push(["burst1w", PROFILES.burst, 1]);
    for (const [i, [key, profile, w]] of runs.entries()) {
      console.log(`load: ${key} (${profile.rate}/s for ${profile.durationS} s, ${w} worker(s))`);
      const r = await runProfile(profile, w, key, i + 1);
      results[key] = r;
      const failed = Object.entries(r.checks)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      if (r.ackP95Ms === null || r.ackP95Ms >= SLO_ACK_P95_MS) {
        breach = true;
        console.error(
          `load: ${key}: ack p95 ${r.ackP95Ms} ms breaches the ${SLO_ACK_P95_MS} ms SLO`,
        );
      }
      if (failed.length) {
        breach = true;
        console.error(`load: ${key}: failed checks: ${failed.join(", ")}`);
      }
    }
    if (!args.includes("--skip-storage")) {
      console.log(`load: storage (${storagePayments} payments)`);
      results.storage = await runStorage(workersArg);
    }
  } finally {
    await stopChild(web);
  }
  results.finishedAt = new Date().toISOString();
  results.loadAverageAtEnd = loadavg().map((n) => Math.round(n * 100) / 100);
  results.scratchDir = scratch;
  writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);

  const rows = Object.entries(results)
    .filter(([, v]) => typeof v === "object" && v !== null && "ackMs" in (v as object))
    .map(([k, v]) => {
      const r = v as Awaited<ReturnType<typeof runProfile>>;
      return {
        run: k,
        workers: r.workers,
        "rate/s": `${r.rateAchieved} (${r.rateTarget})`,
        sent: r.deliveries,
        dupes: r.duplicatesSent,
        errors: r.errors,
        "ack p50": r.ackMs.p50,
        "ack p95": r.ackMs.p95,
        "ack p99": r.ackMs.p99,
        "job p50": r.jobLatencyMs.p50,
        "job p95": r.jobLatencyMs.p95,
        "job p99": r.jobLatencyMs.p99,
        "max depth": r.maxQueueDepth,
        "drain ms": r.drainMsAfterLastSend,
        "cpu %": r.workerCpuPctOfOneCore,
        "rss MiB": r.workerPeakRssMiB,
        checks: Object.values(r.checks).every(Boolean) ? "pass" : "FAIL",
      };
    });
  console.table(rows);
  if (results.storage) {
    const s = results.storage as Awaited<ReturnType<typeof runStorage>>;
    console.log(
      `storage: ${s.bytesPerPaymentRelational} relational bytes per payment (claim ${s.architectureClaimBytes}); ` +
        `${s.mbPerDayAt100x} MB/day, ${s.gbPerYearAt100x} GB/year at 5,000 payments/day; documents avg ${s.documents.avgBytes} B`,
    );
  }
  console.log(`load: results written to ${outPath}`);
  return breach ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`load: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  },
);
