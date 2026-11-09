// Offline replay of the M1-08 walking skeleton (M1-GATE scope 4).
//
//   npx tsx scripts/skeleton-replay.ts --fixtures fixtures/airwallex/m1-skeleton --offline
//
// Needs DATABASE_URL (app role) and DATABASE_MIGRATION_URL (migration role) of a LOCAL Postgres
// (synthetic credentials, see packages/db/sql/roles.sql). It creates a scratch database, migrates it,
// and drops it at the end.
//
// What runs for real: the signature-verified route (POST /api/webhooks/airwallex), the inbox and
// outbox repos, the worker loop and its `transfer.sync` handler, `applyTransferUpdate` and the
// `project()` status projection. What is stubbed (the only stub): the Airwallex adapter's
// `getTransfer`, which answers with the transfer resource contained in the recorded payload.
//
// The recorded signatures were made with the real webhook secret, which this script never reads or
// needs: each recorded body is re-signed with a secret generated here, per run.
//
// No network: `globalThis.fetch` is replaced by a guard that throws for any request that is not to
// localhost. Any mismatch prints a message and exits 1.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeWebhookSignature, type Transfer, TransferWire } from "@carnet/airwallex";
import {
  createBusiness,
  createDbClient,
  createPayment,
  getPayment,
  repoCtx,
  runMigrations,
} from "@carnet/db";
import { money, project } from "@carnet/domain";
import pg from "pg";
import { POST } from "../apps/web/src/app/api/webhooks/airwallex/route";
import { closeAppDb } from "../apps/web/src/server/db";
import { memoryLogger } from "../apps/web/src/server/log";
import { createWorker } from "../apps/web/src/worker/loop";
import { defaultRegistry } from "../apps/web/src/worker/run";
import { parseJsonPreservingNumbers } from "../packages/airwallex/src/json";

interface Recorded {
  file: string;
  name: string;
  received_at: string;
  signature_ok: boolean;
  body: string;
  event: { id: string; name: string; data: Record<string, unknown> };
}

const failures: string[] = [];
function check(ok: boolean, message: string): void {
  if (ok) console.log(`  ok   ${message}`);
  else {
    console.error(`  FAIL ${message}`);
    failures.push(message);
  }
}

function fail(message: string): never {
  console.error(`skeleton-replay: ${message}`);
  process.exit(1);
}

// ---- arguments and the network guard ---------------------------------------------------------
const args = process.argv.slice(2);
const fixturesArg = args[args.indexOf("--fixtures") + 1];
if (args.indexOf("--fixtures") < 0 || !fixturesArg) fail("--fixtures <dir> is required");
if (!args.includes("--offline")) fail("--offline is required (this replay never uses the network)");

const blocked: string[] = [];
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
globalThis.fetch = (async (input: unknown) => {
  const raw = input instanceof Request ? input.url : String(input);
  let host = "";
  try {
    host = new URL(raw).hostname;
  } catch {
    // relative or malformed: not local either
  }
  if (!LOCAL.has(host)) {
    blocked.push(raw);
    throw new Error(`skeleton-replay: outbound request blocked (offline): ${raw}`);
  }
  blocked.push(`(local, unexpected in this replay) ${raw}`);
  throw new Error(`skeleton-replay: no local HTTP server in this replay: ${raw}`);
}) as typeof fetch;

function localUrl(key: "DATABASE_URL" | "DATABASE_MIGRATION_URL"): URL {
  const raw = process.env[key];
  if (!raw) fail(`${key} is not set (local Postgres, see packages/db/sql/roles.sql)`);
  const url = new URL(raw);
  if (!LOCAL.has(url.hostname) && url.hostname !== "postgres") {
    fail(`${key} must point at a local Postgres (got host ${url.hostname})`);
  }
  return url;
}

function withDatabase(url: URL, database: string): string {
  const copy = new URL(url.toString());
  copy.pathname = `/${database}`;
  return copy.toString();
}

// ---- fixtures --------------------------------------------------------------------------------
const dir = resolve(fixturesArg);
const recorded: Recorded[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
  .map((file) => {
    const raw = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as {
      name: string;
      received_at: string;
      signature_ok: boolean;
      body_utf8: string;
    };
    return {
      file,
      name: raw.name,
      received_at: raw.received_at,
      signature_ok: raw.signature_ok,
      body: raw.body_utf8,
      event: JSON.parse(raw.body_utf8),
    };
  })
  .sort(
    (a, b) => Date.parse(a.received_at) - Date.parse(b.received_at) || a.file.localeCompare(b.file),
  );

if (recorded.length !== 7) fail(`expected 7 recorded webhooks in ${dir}, found ${recorded.length}`);
if (recorded.some((r) => !r.signature_ok))
  fail("a recorded webhook was not signature_ok when captured");
const paidFixture = recorded.find((r) => r.name === "payout.transfer.paid");
if (!paidFixture) fail("no payout.transfer.paid fixture");
const recordedStatus = String(paidFixture.event.data.status);
const transferId = String(paidFixture.event.data.id);
if (recorded.some((r) => r.event.data.id !== transferId))
  fail("fixtures belong to more than one transfer");

// ---- scratch database ------------------------------------------------------------------------
async function withClient<T>(
  connectionString: string,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const migration = localUrl("DATABASE_MIGRATION_URL");
  const app = localUrl("DATABASE_URL");
  const dbName = `carnet_replay_${randomBytes(4).toString("hex")}`;
  const maintenanceUrl = migration.toString();
  await withClient(maintenanceUrl, (c) => c.query(`CREATE DATABASE "${dbName}"`));
  try {
    await runMigrations(withDatabase(migration, dbName));
    const appUrl = withDatabase(app, dbName);
    process.env.DATABASE_URL = appUrl;
    // A secret generated for this run only; the route reads it like production does.
    const secret = `whsec_replay_${randomBytes(24).toString("hex")}`;
    process.env.AIRWALLEX_WEBHOOK_SECRET = secret;
    process.env.LOG_LEVEL = "warn";
    await replay(appUrl, secret);
  } finally {
    await closeAppDb().catch(() => undefined);
    await withClient(maintenanceUrl, (c) =>
      c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`),
    ).catch((e) => console.error(`could not drop ${dbName}: ${String(e)}`));
  }
}

async function replay(appUrl: string, secret: string): Promise<void> {
  const client = createDbClient(appUrl, { max: 4 });
  const db = client.db;
  const sql = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    withClient(appUrl, async (c) => (await c.query(text, params)).rows as T[]);

  try {
    // One business and one payment linked to the recorded transfer (as M1-08's executor links it).
    const businessId = await createBusiness(db, { name: "Replay Co" });
    const ctx = repoCtx(db, businessId);
    const payment = await createPayment(ctx, {
      amount: money(2500n, "USD"),
      sourceCurrency: "USD",
      method: "LOCAL",
      reference: String(paidFixture?.event.data.reference ?? "skeleton replay"),
    });
    await sql("UPDATE payments SET transfer_id = $1 WHERE id = $2", [transferId, payment.id]);

    // The adapter stub: GET /transfers/{id} answers the resource inside the most recently delivered
    // recorded payload (the same thing Airwallex returns for an event that is current).
    let current: Transfer | null = null;
    const adapter = {
      getTransfer: async (id: string): Promise<Transfer> => {
        if (!current || current.id !== id) throw new Error(`adapter stub: no resource for ${id}`);
        return current;
      },
      getRfi: async () => {
        throw new Error("adapter stub: getRfi is not part of the skeleton");
      },
      listRfis: async () => {
        throw new Error("adapter stub: listRfis is not part of the skeleton");
      },
      findTransferByRequestId: async () => {
        throw new Error("adapter stub: findTransferByRequestId is not part of the skeleton");
      },
    };
    const logger = memoryLogger();
    const worker = createWorker({
      db,
      registry: defaultRegistry(),
      airwallex: adapter as never,
      logger,
      reconcileEveryMs: null,
    });
    const drain = async () => {
      while (await worker.tick()) {
        /* run every due job */
      }
    };

    const post = (body: string, headers?: Record<string, string>) => {
      const ts = String(Date.now());
      return POST(
        new Request("http://localhost/api/webhooks/airwallex", {
          method: "POST",
          headers: headers ?? {
            "content-type": "application/json",
            "x-timestamp": ts,
            "x-signature": computeWebhookSignature(secret, ts, body),
          },
          body,
        }),
      );
    };

    console.log(`replaying ${recorded.length} recorded webhooks of transfer ${transferId}`);

    // A tampered body must be rejected by the route and stored nowhere.
    const forged = await post(recorded[0]?.body ?? "", {
      "content-type": "application/json",
      "x-timestamp": String(Date.now()),
      "x-signature": "0".repeat(64),
    });
    check(forged.status === 401, `bad signature is rejected with 401 (got ${forged.status})`);

    for (const r of recorded) {
      // The resource inside the payload, parsed the way the adapter parses a GET response.
      const payload = parseJsonPreservingNumbers(r.body) as { data: unknown };
      current = TransferWire.parse(payload.data);
      const res = await post(r.body);
      const json = (await res.json()) as { received?: boolean; duplicate?: boolean };
      check(
        res.status === 200 && json.received === true && json.duplicate === false,
        `${r.name} (${r.event.id.slice(0, 8)}) accepted as new: ${res.status} duplicate=${json.duplicate}`,
      );
      await drain();
    }

    const events = await sql<{
      provider_event_id: string;
      signature_ok: boolean;
      processed_at: Date | null;
      raw_body: string;
    }>("SELECT provider_event_id, signature_ok, processed_at, raw_body FROM webhook_events");
    const expectedIds = new Set(recorded.map((r) => r.event.id));
    check(events.length === 7, `7 webhook_events rows stored (got ${events.length})`);
    check(
      new Set(events.map((e) => e.provider_event_id)).size === 7 &&
        events.every((e) => expectedIds.has(e.provider_event_id)),
      "each recorded event id is stored exactly once",
    );
    check(
      events.every((e) => e.signature_ok),
      "every stored event is marked signature_ok",
    );
    check(
      events.every((e) => recorded.some((r) => r.body === e.raw_body)),
      "raw bodies are stored byte for byte",
    );
    check(
      events.every((e) => e.processed_at !== null),
      "every event was applied (processed_at set by transfer.sync)",
    );
    const jobs = await sql<{ kind: string }>("SELECT kind FROM outbox_jobs");
    check(
      jobs.length === 7 && jobs.every((j) => j.kind === "transfer.sync"),
      `7 transfer.sync jobs enqueued (got ${jobs.length})`,
    );

    const stored = await getPayment(ctx, payment.id);
    const finalStatus = stored?.transferStatus ?? null;
    check(
      finalStatus === recordedStatus,
      `stored transfer status ${finalStatus} equals the recorded ${recordedStatus}`,
    );
    const projected = finalStatus ? project(finalStatus, false) : null;
    check(
      projected?.view === recordedStatus,
      `projected payment status ${projected?.view} equals the recorded ${recordedStatus}`,
    );

    // Re-delivery of an event already applied: de-duplicated, not stored again, no new job.
    const again = recorded[recorded.length - 1];
    if (!again) fail("no fixture to redeliver");
    const before = (await sql<{ n: string }>("SELECT count(*) AS n FROM outbox_jobs"))[0]?.n;
    const res = await post(again.body);
    const json = (await res.json()) as { duplicate?: boolean };
    check(
      res.status === 200 && json.duplicate === true,
      `re-delivered ${again.name} is acknowledged as duplicate`,
    );
    await drain();
    const after = await sql<{ events: string; jobs: string }>(
      "SELECT (SELECT count(*) FROM webhook_events) AS events, (SELECT count(*) FROM outbox_jobs) AS jobs",
    );
    check(
      Number(after[0]?.events) === 7,
      `still 7 events after re-delivery (got ${after[0]?.events})`,
    );
    check(
      after[0]?.jobs === before,
      `no new job after re-delivery (${before} -> ${after[0]?.jobs})`,
    );
    const finalAgain = await getPayment(ctx, payment.id);
    check(finalAgain?.transferStatus === recordedStatus, "status unchanged by the re-delivery");

    check(blocked.length === 0, `no outbound request attempted (${blocked.length})`);
    const errors = logger.lines.filter((l) => l.level === "error");
    check(errors.length === 0, `worker logged no errors (${errors.length})`);
  } finally {
    await client.close();
  }
}

main()
  .then(() => {
    if (failures.length > 0) {
      console.error(`skeleton-replay: FAILED, ${failures.length} assertion(s) did not hold:`);
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log("skeleton-replay: PASS");
    process.exit(0);
  })
  .catch((error) => {
    console.error(
      `skeleton-replay: error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exit(1);
  });
