// Seeds the database behind the REPLAY variant of the core demo (M2-09, core-demo.replay.spec.ts) with
// REAL pipeline output over the recorded model responses of the live run (fixtures/anthropic/m2-run/):
// the dataset PDFs are stored as documents, their facts come from the real extraction pipeline replaying
// the m2-run extraction recordings, and the RFI is drafted by the real `rfi.draft` handler replaying the
// m2-run drafting recording (ids of the live database are mapped to this database's by the recording's
// `id_map`). No Airwallex call and no model call is made; the Airwallex side of the live run is NOT
// reproduced here.
//
//   npx tsx apps/web/e2e/fixtures/seed-m2-run.ts seed   prints { strong, weak, rfi } ids as JSON
//
// Needs DATABASE_URL (app role) and the SEED_*_PASSWORD variables; prints ids only, never a secret.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createHarness,
  type ExtractionResult,
  extractDocument,
  type Transport,
} from "@carnet/agent";
import {
  attachEvidenceLink,
  createCounterparty,
  createDbClientFromEnv,
  createPayment,
  enqueueJob,
  getJob,
  insertFactsVersion,
  insertRfi,
  insertRfiQuestions,
  listRfiQuestions,
  repoCtx,
  seedDemoUsers,
  storeDocument,
  updatePaymentTransfer,
} from "@carnet/db";
import { type BusinessId, money, type PaymentId, type RfiId } from "@carnet/domain";
import { replayTransport } from "../../../../packages/agent/evals/extraction/run";
import { memoryStore } from "../../../../packages/agent/test/memory-store";
import { memoryLogger } from "../../src/server/log";
import { createRfiDraftHandler, RFI_DRAFT_JOB_KIND } from "../../src/worker/handlers/draft";
import type { HandlerContext } from "../../src/worker/handlers/index";

process.env.ANTHROPIC_API_KEY ||= "replay-not-a-key";
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DATASET = `${ROOT}fixtures/dataset/`;
const M2 = `${ROOT}fixtures/anthropic/m2-run/`;
const client = createDbClientFromEnv(process.env, { max: 2 });
const db = client.db;
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

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

const docUuid = new Map<string, string>(); // dataset id -> uuid
const versionUuid = new Map<string, string>(); // dataset id -> fact version uuid
let businessId: BusinessId;

/** Extraction of one dataset document, replaying the live run's recorded model response. */
async function extractFromRecording(id: string, kind: string): Promise<ExtractionResult> {
  const rec = readJson<{ calls: Parameters<typeof replayTransport>[0]["calls"] }>(
    `${M2}extraction/${id}.json`,
  );
  const harness = createHarness({
    store: memoryStore({ agentsEnabled: true }),
    transport: replayTransport(rec),
  });
  const run = await harness.startRun({ kind: "extraction-eval", ref: id });
  return extractDocument({
    harness,
    run,
    step: "extract:m2-run",
    document: {
      kind: kind as "invoice",
      mime: "application/pdf",
      bytes: new Uint8Array(readFileSync(`${DATASET}${id}.pdf`)),
    },
  });
}

// The documents the live run uploaded; the scan (image-only, needs the owner to confirm) is not seeded.
const DOCS = [
  "inv-harbor-001",
  "po-harbor-001",
  "contract-harbor",
  "inv-lakeside-001",
  "inv-lakeside-002",
  "dn-harbor-001",
  "remit-brightline-001",
];

async function loadDocuments(): Promise<void> {
  const repo = repoCtx(db, businessId);
  const gt = readJson<{ documents: GtDocument[] }>(`${DATASET}ground-truth.json`);
  for (const id of DOCS) {
    const d = gt.documents.find((x) => x.id === id);
    if (!d) throw new Error(`${id} not in ground truth`);
    const kind = ["delivery_note", "remittance_advice"].includes(d.kind) ? "other" : d.kind;
    const stored = await storeDocument(repo, {
      kind: kind as "invoice",
      filename: d.file,
      mime: "application/pdf",
      bytes: new Uint8Array(readFileSync(`${DATASET}${d.file}`)),
    });
    docUuid.set(id, stored.document.id);
    if (kind === "other") continue;
    const result = await extractFromRecording(id, kind);
    if (result.status !== "EXTRACTED") throw new Error(`${id}: replayed extraction failed`);
    const v = await insertFactsVersion(repo, {
      documentId: stored.document.id,
      source: "model",
      status: "EXTRACTED",
      textLayer: true,
      facts: result.facts,
    });
    versionUuid.set(id, v.version.id);
  }
}

interface DraftRecording {
  id_map: {
    questions: Record<string, string>;
    fact_versions: Record<string, string>;
    documents: Record<string, string>;
  };
  calls: {
    response: { id: string; model: string; stop_reason: string; usage: unknown; content: unknown };
  }[];
}

/** The recorded model reply with this database's ids in place of the live database's. */
function replyFor(qIds: Map<string, string>): Transport {
  const rec = readJson<DraftRecording>(`${M2}drafting/rfi-set-harbor-m2-run-r1.json`);
  const call = rec.calls[0];
  if (!call) throw new Error("recording has no call");
  let text = JSON.stringify(call.response.content);
  const swap = (live: string, now: string | undefined) => {
    if (!now) throw new Error(`no id to map ${live} to`);
    text = text.replaceAll(live, now);
  };
  for (const [live, ds] of Object.entries(rec.id_map.fact_versions))
    swap(live, versionUuid.get(ds));
  for (const [live, ds] of Object.entries(rec.id_map.documents)) swap(live, docUuid.get(ds));
  for (const [live, ds] of Object.entries(rec.id_map.questions)) swap(live, qIds.get(ds));
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

const ctxOf = (): HandlerContext => ({ db, logger: memoryLogger() }) as unknown as HandlerContext;

async function main(): Promise<void> {
  const seeded = await seedDemoUsers(db, { env: process.env });
  businessId = seeded.businessId;
  const ownerId = seeded.users.find((u) => u.role === "owner")?.id as string;
  await loadDocuments();
  const repo = repoCtx(db, businessId);
  const suffix = Date.now().toString(36);

  const pay = async (name: string, amountMinor: bigint, reference: string, links: string[]) => {
    const counterparty = await createCounterparty(repo, { name, country: "US" });
    const payment = await createPayment(repo, {
      counterpartyId: counterparty.id,
      amount: money(amountMinor, "USD"),
      sourceCurrency: "USD",
      method: "SWIFT",
      reference,
    });
    for (const id of links) {
      await attachEvidenceLink(repo, {
        paymentId: payment.id as PaymentId,
        documentId: docUuid.get(id) as never,
        createdBy: ownerId,
      });
    }
    return payment;
  };
  // The live run's two payments: Harbor (invoice + purchase order + contract) and Lakeside (invoice only).
  const strong = await pay("Harbor Print Co.", 480000n, `M2REPLAY-${suffix}-001`, [
    "inv-harbor-001",
    "po-harbor-001",
    "contract-harbor",
  ]);
  const weak = await pay("Lakeside Freight Ltd", 132050n, `M2REPLAY-${suffix}-003`, [
    "inv-lakeside-001",
  ]);
  await updatePaymentTransfer(repo, strong.id, {
    transferId: `tr_replay_${suffix}`,
    transferStatus: "PROCESSING",
    transferUpdatedAt: new Date(),
  });

  const set = readJson<{ rounds: { round: number; questions: SetQuestion[] }[] }>(
    `${DATASET}rfi-sets/rfi-set-harbor.json`,
  );
  const round1 = set.rounds.find((r) => r.round === 1);
  if (!round1) throw new Error("no round 1");
  const rfi = await insertRfi(repo, {
    airwallexRfiId: `replay-m2-run-${suffix}`,
    type: "TRANSACTION",
    subType: null,
    airwallexStatus: "ACTION_REQUIRED",
    airwallexUpdatedAt: new Date(Date.now() - 60_000),
    airwallexAnsweredRequests: 0,
    state: "DRAFTING",
    round: 1,
    expiresAt: new Date(Date.now() + 48 * 3_600_000),
    paymentId: strong.id as PaymentId,
    orphanReason: null,
    linkedBy: "match",
    sourceKey: `replay:m2-run:${suffix}`,
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
  const jobId = await enqueueJob(db, {
    kind: RFI_DRAFT_JOB_KIND,
    payload: { businessId, rfiId: rfi.id, round: 1 },
  });
  const job = await getJob(db, jobId);
  if (!job) throw new Error("job missing");
  await createRfiDraftHandler({ transport: replyFor(qIds) })(
    { businessId, rfiId: rfi.id as RfiId, round: 1 },
    ctxOf(),
    job,
  );
  process.stdout.write(
    `${JSON.stringify({ strong: strong.id, weak: weak.id, rfi: rfi.id, reference: strong.reference })}\n`,
  );
}

try {
  await main();
} finally {
  await client.close();
}
