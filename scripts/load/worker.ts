// M4-06 load test: one worker process (run.ts starts 1 or 3 of them).
//
// Real: the worker loop (`startWorker`, SKIP LOCKED claims, retries), the `transfer.sync` and
// `rfi.sync` handlers, the Airwallex adapter (`createAirwallexClient`) and every database write.
// Replayed: the adapter's HTTP layer. Importing the test fixture loader replaces `globalThis.fetch`
// with a guard that throws, so nothing leaves the machine; the client's own fetch is a local stub
// answering `GET /transfers/{id}` and `GET /rfis/{id}` from the recorded M2-09 bodies, at the state
// the plan has delivered by now (plan.ts `currentStep`). No Airwallex and no model call is possible.
//
// Downstream jobs that would call the model or read balances (`rfi.draft`, `plan.rerun`) are
// completed by a counting no-op: they are not part of the webhook path this test measures.
//
// Env: DATABASE_URL (local), LOAD_INDEX (replay index JSON), LOAD_WORKER_ID, LOAD_CLAIMS_OUT.
import { readFileSync, writeFileSync } from "node:fs";
import { createLogger } from "../../apps/web/src/server/log";
import { defaultRegistry, startWorker, stopSignalFromProcess } from "../../apps/web/src/worker/run";
import { FetchStub, loadFixture, makeClient } from "../../packages/airwallex/test/fixture-loader";
import { currentStep, type ReplayIndex } from "./plan";

const indexPath = process.env.LOAD_INDEX;
const workerId = process.env.LOAD_WORKER_ID ?? "w?";
const claimsOut = process.env.LOAD_CLAIMS_OUT;
if (!indexPath || !claimsOut) {
  console.error("load worker: LOAD_INDEX and LOAD_CLAIMS_OUT are required");
  process.exit(2);
}
// Read lazily: run.ts writes the index once every worker is ready (no delivery happens before that).
let loaded: ReplayIndex | null = null;
const replay = (): ReplayIndex => {
  loaded ??= JSON.parse(readFileSync(indexPath, "utf8")) as ReplayIndex;
  return loaded;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notFound = () => json(404, { code: "resource_not_found", message: "not found" });

const rfiTemplate = loadFixture("rfi-check1-fetch").response.body as Record<string, unknown>;
const RFI_TEMPLATE_TRANSFER = "258d17cc-e230-4fa1-be0d-09c5c06269c0";

const stub = new FetchStub()
  .on("GET", /^\/api\/v1\/transfers\/[^/]+$/, (call) => {
    const steps = replay().transfers[call.path.split("/").pop() ?? ""];
    const step = steps ? currentStep(steps, Date.now()) : undefined;
    return step ? json(200, step.data) : notFound();
  })
  .on("GET", /^\/api\/v1\/rfis\/[^/]+$/, (call) => {
    const id = call.path.split("/").pop() ?? "";
    const rfi = replay().rfis[id];
    const step = rfi ? currentStep(rfi.steps, Date.now()) : undefined;
    if (!rfi || !step) return notFound();
    const closed = step.name === "rfi.closed";
    const body = JSON.parse(
      JSON.stringify(rfiTemplate).replaceAll(RFI_TEMPLATE_TRANSFER, rfi.transferId),
    ) as Record<string, unknown>;
    return json(200, {
      ...body,
      id,
      status: closed ? "CLOSED" : "ACTION_REQUIRED",
      updated_at: closed ? "2026-11-03T10:30:00+0000" : body.updated_at,
    });
  });
const client = makeClient(stub);

const claims: { jobId: string; kind: string; worker: string; startedAt: number }[] = [];
const downstream = new Map<string, number>();
const registry = defaultRegistry();
for (const kind of ["rfi.draft", "plan.rerun"]) {
  registry.set(kind, {
    mutating: false,
    handle: async () => {
      downstream.set(kind, (downstream.get(kind) ?? 0) + 1);
    },
  });
}
for (const [kind, def] of registry) {
  registry.set(kind, {
    ...def,
    handle: (payload, ctx, job) => {
      claims.push({ jobId: job.id, kind, worker: workerId, startedAt: Date.now() });
      return def.handle(payload, ctx, job);
    },
  });
}

const logger = createLogger({ process: "worker", loadWorker: workerId });
const t0 = process.cpuUsage();
writeFileSync(`${claimsOut}.ready`, String(Date.now()));
await startWorker({
  signal: stopSignalFromProcess(logger),
  logger,
  registry,
  airwallex: client,
  reconcileEveryMs: null,
});
const cpu = process.cpuUsage(t0);
writeFileSync(
  claimsOut,
  JSON.stringify({
    worker: workerId,
    claims,
    downstream: Object.fromEntries(downstream),
    unmatched: stub.unmatched,
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
  }),
);
process.exit(0);
