// Seeds the database behind the hold-screen Playwright run (M2-08) with REAL pipeline output over
// recorded responses: the dataset's PDFs are stored as documents, their facts come from the real
// extraction pipeline replaying the M2-02 recordings, and each RFI is drafted by the real `rfi.draft`
// handler replaying the M2-05 model recordings (so citations, verbatim quotes and verifier verdicts
// are exactly what the product stores). Nothing is faked in the product path; no Airwallex or model
// call is made.
//
//   npx tsx apps/web/e2e/fixtures/seed-hold.ts seed            prints { name: { id, airwallexId, ... } }
//   npx tsx apps/web/e2e/fixtures/seed-hold.ts advance <name>  runs the draft handler for a DRAFTING RFI
//   npx tsx apps/web/e2e/fixtures/seed-hold.ts touch <name>    bumps the RFI's Airwallex updated_at
//   npx tsx apps/web/e2e/fixtures/seed-hold.ts kill on|off     the execution kill switch
//
// Needs DATABASE_URL (app role) and the SEED_*_PASSWORD variables; prints ids only, never a secret.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Transport } from "@carnet/agent";
import {
  createCounterparty,
  createDbClientFromEnv,
  createPayment,
  enqueueJob,
  ensureDemoBusiness,
  findDocumentBySha256,
  getJob,
  getLatestFacts,
  getRfi,
  insertFactsVersion,
  insertRfi,
  insertRfiQuestions,
  listRfiQuestions,
  repoCtx,
  schema,
  seedDemoUsers,
  storeDocument,
  updatePaymentTransfer,
  updateRfi,
} from "@carnet/db";
import { type BusinessId, money, type PaymentId, type RfiId } from "@carnet/domain";
import { eq } from "drizzle-orm";
import { runExtractionForEval } from "../../../../packages/agent/evals/drafting/facts";
import { loadDraftRecording } from "../../../../packages/agent/evals/drafting/run";
import { memoryLogger } from "../../src/server/log";
import { createRfiDraftHandler, RFI_DRAFT_JOB_KIND } from "../../src/worker/handlers/draft";
import type { HandlerContext } from "../../src/worker/handlers/index";

process.env.ANTHROPIC_API_KEY ||= "replay-not-a-key";
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DATASET = `${ROOT}fixtures/dataset/`;
const client = createDbClientFromEnv(process.env, { max: 2 });
const db = client.db;

interface GtDocument {
  id: string;
  file: string;
  kind: string;
}
interface SetQuestion {
  id: string;
  title: { en: string };
  description: { en: string };
  answer: { type: string };
}
interface RfiSet {
  rounds: { round: number; questions: SetQuestion[] }[];
}
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const docUuid = new Map<string, string>();
const versionUuid = new Map<string, string>();
let businessId: BusinessId;

async function loadDocuments(): Promise<void> {
  const repo = repoCtx(db, businessId);
  const gt = readJson<{ documents: GtDocument[] }>(`${DATASET}ground-truth.json`);
  const extracted = await runExtractionForEval();
  for (const d of gt.documents) {
    if (!d.file.endsWith(".pdf")) continue; // the scanned PNG is image-only: out of this fixture
    const bytes = new Uint8Array(readFileSync(`${DATASET}${d.file}`));
    // Delivery notes and remittance advices have no extraction schema: kind `other`.
    const kind =
      d.kind === "bank_statement"
        ? "statement"
        : ["delivery_note", "remittance_advice"].includes(d.kind)
          ? "other"
          : d.kind;
    const stored = await storeDocument(repo, {
      kind: kind as "invoice",
      filename: d.file,
      mime: "application/pdf",
      bytes,
    });
    docUuid.set(d.id, stored.document.id);
    const result = extracted.get(d.id);
    if (kind === "other" || result?.status !== "EXTRACTED") continue;
    const existing = await getLatestFacts(repo, stored.document.id);
    if (existing) {
      versionUuid.set(d.id, existing.id);
      continue;
    }
    const v = await insertFactsVersion(repo, {
      documentId: stored.document.id,
      source: "model",
      status: "EXTRACTED",
      textLayer: true,
      facts: result.facts,
    });
    versionUuid.set(d.id, v.version.id);
  }
  void findDocumentBySha256;
}

/** The recorded model reply with this database's ids in place of the recording's. */
function replyFor(setId: string, qIds: Map<string, string>): Transport {
  const rec = loadDraftRecording(setId);
  const call = rec.calls[0];
  if (!call) throw new Error("recording has no call");
  let text = JSON.stringify(call.response.content);
  text = text.replace(
    /([a-z0-9-]+)@1#(\d+)/g,
    (_m, doc: string, i: string) => `${versionUuid.get(doc)}#${i}`,
  );
  for (const [doc, uuid] of docUuid) text = text.replaceAll(`\\"${doc}\\"`, `\\"${uuid}\\"`);
  for (const [q, uuid] of qIds) text = text.replaceAll(`\\"${q}\\"`, `\\"${uuid}\\"`);
  const content = JSON.parse(text) as unknown;
  return async () =>
    new Response(
      JSON.stringify({
        id: call.response.id,
        type: "message",
        role: "assistant",
        model: call.response.model,
        content,
        stop_reason: call.response.stop_reason,
        stop_sequence: null,
        usage: call.response.usage,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

/** The real recorded 401 from the provider (fixtures/anthropic/drafting/provider-error-401.json). */
function providerError(): Transport {
  const rec = readJson<{ status: number; body: unknown }>(
    `${ROOT}fixtures/anthropic/drafting/provider-error-401.json`,
  );
  return async () =>
    new Response(JSON.stringify(rec.body), {
      status: rec.status,
      headers: { "content-type": "application/json" },
    });
}

const ctxOf = (): HandlerContext => ({ db, logger: memoryLogger() }) as unknown as HandlerContext;

async function runDraft(rfiId: RfiId, transport: Transport, round = 1): Promise<void> {
  const jobId = await enqueueJob(db, {
    kind: RFI_DRAFT_JOB_KIND,
    payload: { businessId, rfiId, round },
  });
  const job = await getJob(db, jobId);
  if (!job) throw new Error("job missing");
  await createRfiDraftHandler({ transport })({ businessId, rfiId, round }, ctxOf(), job);
}

interface Spec {
  name: string;
  set: string;
  counterparty: string;
  reference: string;
  amountMinor: bigint;
  currency: "EUR" | "USD";
  linked: boolean;
  draft: "model" | "provider-error" | "none";
  finalState?: "EXPIRED" | "ANSWERED";
  hoursLeft: number;
}

const SPECS: Spec[] = [
  {
    name: "draft-ready",
    set: "rfi-set-rhein-followup",
    counterparty: "Rheinblick Druck GmbH",
    reference: "RD-2026-1180",
    amountMinor: 720000n,
    currency: "EUR",
    linked: true,
    draft: "model",
    hoursLeft: 26,
  },
  {
    name: "needs-owner",
    set: "rfi-set-lakeside",
    counterparty: "Lakeside Freight Ltd",
    reference: "LF-2026-0412",
    amountMinor: 1850000n,
    currency: "USD",
    linked: true,
    draft: "model",
    hoursLeft: 30,
  },
  {
    name: "needs-owner-view",
    set: "rfi-set-lakeside",
    counterparty: "Lakeside Freight Ltd",
    reference: "LF-2026-0413",
    amountMinor: 1850000n,
    currency: "USD",
    linked: true,
    draft: "model",
    hoursLeft: 30,
  },
  {
    name: "model-unavailable",
    set: "rfi-set-harbor",
    counterparty: "Harbor Print Co.",
    reference: "HP-2026-0233",
    amountMinor: 640000n,
    currency: "USD",
    linked: true,
    draft: "provider-error",
    hoursLeft: 30,
  },
  {
    name: "expired",
    set: "rfi-set-rhein-followup",
    counterparty: "Rheinblick Druck GmbH",
    reference: "RD-2026-1099",
    amountMinor: 310000n,
    currency: "EUR",
    linked: true,
    draft: "model",
    finalState: "EXPIRED",
    hoursLeft: -20,
  },
  {
    name: "answered",
    set: "rfi-set-rhein-followup",
    counterparty: "Rheinblick Druck GmbH",
    reference: "RD-2026-1050",
    amountMinor: 280000n,
    currency: "EUR",
    linked: true,
    draft: "model",
    finalState: "ANSWERED",
    hoursLeft: 20,
  },
  {
    name: "approve",
    set: "rfi-set-rhein-followup",
    counterparty: "Rheinblick Druck GmbH",
    reference: "RD-2026-1201",
    amountMinor: 450000n,
    currency: "EUR",
    linked: true,
    draft: "model",
    hoursLeft: 28,
  },
  {
    name: "stale",
    set: "rfi-set-rhein-followup",
    counterparty: "Rheinblick Druck GmbH",
    reference: "RD-2026-1202",
    amountMinor: 450000n,
    currency: "EUR",
    linked: true,
    draft: "model",
    hoursLeft: 28,
  },
  {
    name: "edit",
    set: "rfi-set-harbor",
    counterparty: "Harbor Print Co.",
    reference: "HP-2026-0301",
    amountMinor: 640000n,
    currency: "USD",
    linked: true,
    draft: "model",
    hoursLeft: 28,
  },
  {
    name: "keyboard",
    set: "rfi-set-rhein-followup",
    counterparty: "Rheinblick Druck GmbH",
    reference: "RD-2026-1203",
    amountMinor: 450000n,
    currency: "EUR",
    linked: true,
    draft: "model",
    hoursLeft: 28,
  },
  {
    name: "poll",
    set: "rfi-set-harbor",
    counterparty: "Harbor Print Co.",
    reference: "HP-2026-0302",
    amountMinor: 640000n,
    currency: "USD",
    linked: true,
    draft: "none",
    hoursLeft: 28,
  },
  {
    name: "orphan",
    set: "rfi-set-rhein-followup",
    counterparty: "Rheinblick Druck GmbH",
    reference: "RD-2026-1204",
    amountMinor: 450000n,
    currency: "EUR",
    linked: false,
    draft: "model",
    hoursLeft: 28,
  },
];

const suffix = Date.now().toString(36);

async function seedOne(spec: Spec) {
  const repo = repoCtx(db, businessId);
  const set = readJson<RfiSet>(`${DATASET}rfi-sets/${spec.set}.json`);
  const round1 = set.rounds.find((r) => r.round === 1);
  if (!round1) throw new Error("no round 1");
  const counterparty = await createCounterparty(repo, { name: spec.counterparty, country: "DE" });
  const payment = await createPayment(repo, {
    counterpartyId: counterparty.id,
    amount: money(spec.amountMinor, spec.currency),
    sourceCurrency: "USD",
    method: "SWIFT",
    reference: spec.reference,
  });
  await updatePaymentTransfer(repo, payment.id, {
    transferId: `tr_fixture_${spec.name}_${suffix}`,
    transferStatus: "PROCESSING",
    transferUpdatedAt: new Date(),
  });
  const airwallexId = `fixture-${spec.name}-${suffix}`;
  const rfi = await insertRfi(repo, {
    airwallexRfiId: airwallexId,
    type: "TRANSACTION",
    subType: null,
    airwallexStatus: "ACTION_REQUIRED",
    airwallexUpdatedAt: new Date(Date.now() - 60_000),
    airwallexAnsweredRequests: 0,
    state: "DRAFTING",
    round: 1,
    expiresAt: new Date(Date.now() + spec.hoursLeft * 3_600_000),
    paymentId: spec.linked ? (payment.id as PaymentId) : null,
    orphanReason: spec.linked ? null : "NO_SOURCES",
    linkedBy: spec.linked ? "match" : null,
    sourceKey: `fixture:${spec.name}:${suffix}`,
    conflict: false,
  });
  await insertRfiQuestions(
    repo,
    rfi.id,
    round1.questions.map((q, position) => ({
      round: 1,
      airwallexQuestionId: q.id,
      position,
      title: { en: q.title.en, zh: null },
      description: { en: q.description.en, zh: null },
      comment: null,
      answerType: q.answer.type,
      sources: [],
      reopened: false,
      needsDrafting: true,
    })),
  );
  const rows = await listRfiQuestions(repo, rfi.id, 1);
  const qIds = new Map(rows.map((r) => [r.airwallexQuestionId, r.id]));
  if (spec.draft === "model") await runDraft(rfi.id, replyFor(`${spec.set}-r1`, qIds));
  if (spec.draft === "provider-error") await runDraft(rfi.id, providerError());
  if (spec.finalState) await updateRfi(repo, rfi.id, { state: spec.finalState });
  const after = await getRfi(repo, rfi.id);
  return {
    id: rfi.id,
    airwallexId,
    state: after?.state,
    paymentId: payment.id,
    counterparty: spec.counterparty,
    set: spec.set,
    questions: rows.map((r) => ({ id: r.id, awId: r.airwallexQuestionId, title: r.title.en })),
  };
}

async function main(): Promise<void> {
  const [cmd = "seed", arg] = process.argv.slice(2);
  const base = await ensureDemoBusiness(db);
  businessId = base.businessId;
  if (cmd === "seed") {
    await seedDemoUsers(db, { env: process.env, businessId });
    await loadDocuments();
    const out: Record<string, unknown> = {};
    for (const spec of SPECS) out[spec.name] = await seedOne(spec);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  if (cmd === "advance" || cmd === "touch") {
    const repo = repoCtx(db, businessId);
    const [row] = await db
      .select()
      .from(schema.rfis)
      .where(eq(schema.rfis.id, arg ?? ""));
    if (!row) throw new Error(`no RFI ${arg}`);
    if (cmd === "touch") {
      await updateRfi(repo, row.id as RfiId, { airwallexUpdatedAt: new Date() });
      return;
    }
    await loadDocuments();
    const rows = await listRfiQuestions(repo, row.id as RfiId, row.round);
    const set = `${process.argv[4] ?? "rfi-set-harbor"}-r1`;
    await runDraft(
      row.id as RfiId,
      replyFor(set, new Map(rows.map((r) => [r.airwallexQuestionId, r.id]))),
      row.round,
    );
    return;
  }
  if (cmd === "kill") {
    await db
      .update(schema.systemFlags)
      .set({ executionEnabled: arg !== "on" })
      .where(eq(schema.systemFlags.id, 1));
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

try {
  await main();
} finally {
  await client.close();
}
