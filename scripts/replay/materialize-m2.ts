// Materializes the M2-09 recording (`"materialize": "m2-pipeline"`) into one replay business, so the
// real screens (queue, evidence view, hold screen, payment detail, /ops) read it through the same
// repositories as a live business (M4-05, ADR 0018 amendment 2). Same approach as the CI replay of the
// core demo (apps/web/e2e/fixtures/seed-m2-run.ts), with every value from the recording:
//   - documents: the dataset PDFs; facts from the REAL extraction pipeline replaying the model responses
//     recorded in the live run (fixtures/anthropic/m2-run/extraction)
//   - payments: amounts, references and the final transfer id and status from the recorded Airwallex
//     webhooks (fixtures/airwallex/m2-run/webhooks), counterparties as in the live run
//   - the RFI: drafted by the REAL `rfi.draft` handler replaying the recorded drafting response; the
//     owner's own statement for the question the verifier rejected (docs/evidence/m2-run/hold-view-final.json)
//     goes through the real owner-draft path; the RFI's final state from the recorded rfi.* webhooks
// No Airwallex call and no model call is made: the transports below only return recorded bodies.
// The approval and the respond call are on the timeline (recorded files); they are not re-created as rows.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createHarness,
  type ExtractionResult,
  extractDocument,
  type Transport,
} from "@carnet/agent";
import {
  attachEvidenceLink,
  createCounterparty,
  createOwnerDraft,
  createPayment,
  type Db,
  enqueueJob,
  getJob,
  getLatestDraft,
  insertFactsVersion,
  insertRfi,
  insertRfiQuestions,
  listDraftAnswers,
  listRfiQuestions,
  repoCtx,
  storeDocument,
  updatePaymentTransfer,
  updateRfi,
} from "@carnet/db";
import {
  type BusinessId,
  type DocumentId,
  money,
  type PaymentId,
  type RfiId,
  type TransferStatus,
} from "@carnet/domain";
import { sql } from "drizzle-orm";
import { memoryLogger } from "../../apps/web/src/server/log";
import {
  createRfiDraftHandler,
  RFI_DRAFT_JOB_KIND,
} from "../../apps/web/src/worker/handlers/draft";
import type { HandlerContext } from "../../apps/web/src/worker/handlers/index";
import { replayTransport } from "../../packages/agent/evals/extraction/run";
import { memoryStore } from "../../packages/agent/test/memory-store";
import { ROOT } from "./load";

const DATASET = join(ROOT, "fixtures/dataset/");
const ANTHROPIC = join(ROOT, "fixtures/anthropic/m2-run/");
const WEBHOOKS = join(ROOT, "fixtures/airwallex/m2-run/webhooks/");
const HOLD_VIEW = join(ROOT, "docs/evidence/m2-run/hold-view-final.json");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

// The documents the live run uploaded (the image-only scan's payment was not sent; not loaded).
const DOCS = [
  "inv-harbor-001",
  "po-harbor-001",
  "contract-harbor",
  "inv-lakeside-001",
  "inv-lakeside-002",
  "dn-harbor-001",
  "remit-brightline-001",
];

interface RecordedWebhook {
  name: string;
  received_at: string;
  raw_body: string;
}
interface TransferData {
  id: string;
  status: TransferStatus;
  reference?: string | undefined;
  amount_beneficiary_receives?: number;
  updated_at?: string;
}

/** Final state per transfer from the recorded payout.transfer.* webhooks, in received order. */
function recordedTransfers(): Map<string, TransferData & { at: string }> {
  const out = new Map<string, TransferData & { at: string }>();
  for (const f of readdirSync(WEBHOOKS).sort()) {
    const w = readJson<RecordedWebhook>(join(WEBHOOKS, f));
    if (!w.name.startsWith("payout.transfer.")) continue;
    const data = (JSON.parse(w.raw_body) as { data: TransferData }).data;
    const prev = out.get(data.id);
    out.set(data.id, {
      ...prev,
      ...data,
      reference: data.reference ?? prev?.reference,
      at: w.received_at,
    });
  }
  return out;
}

/** The RFI's last recorded webhook (`rfi.closed` for the answered RFI). */
function recordedRfiEnd(airwallexRfiId: string): { name: string; at: string } | null {
  let last: { name: string; at: string } | null = null;
  for (const f of readdirSync(WEBHOOKS).sort()) {
    const w = readJson<RecordedWebhook>(join(WEBHOOKS, f));
    if (!w.name.startsWith("rfi.")) continue;
    const id = (JSON.parse(w.raw_body) as { data: { id: string } }).data.id;
    if (id === airwallexRfiId) last = { name: w.name, at: w.received_at };
  }
  return last;
}

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
interface HoldView {
  rfi: {
    airwallex_rfi_id: string;
    created_at: string;
    expires_at: string;
    airwallex_updated_at: string;
  };
  payment: { counterparty: string; reference: string };
  questions: { title: string; answer: { status: string; text: string } }[];
}

export interface M2Refs {
  strong: string;
  weak: string;
  rfi: string;
}

export async function materializeM2(
  db: Db,
  businessId: BusinessId,
  ownerId: string,
): Promise<M2Refs> {
  // The model client refuses to start without a key even with a recorded transport; this placeholder
  // never leaves the process (every transport here returns a recorded body, no request is sent).
  process.env.ANTHROPIC_API_KEY ||= "replay-not-a-key";
  const repo = repoCtx(db, businessId);
  const docUuid = new Map<string, string>();
  const versionUuid = new Map<string, string>();

  // 1. Documents, and their facts from the real pipeline over the recorded model responses.
  const gt = readJson<{ documents: GtDocument[] }>(`${DATASET}ground-truth.json`);
  for (const id of DOCS) {
    const d = gt.documents.find((x) => x.id === id);
    if (!d) throw new Error(`${id} not in ground truth`);
    const kind = ["delivery_note", "remittance_advice"].includes(d.kind) ? "other" : d.kind;
    const bytes = new Uint8Array(readFileSync(`${DATASET}${d.file}`));
    const stored = await storeDocument(repo, {
      kind: kind as "invoice",
      filename: d.file,
      mime: "application/pdf",
      bytes,
    });
    docUuid.set(id, stored.document.id);
    if (kind === "other") continue;
    const rec = readJson<{ calls: Parameters<typeof replayTransport>[0]["calls"] }>(
      `${ANTHROPIC}extraction/${id}.json`,
    );
    const harness = createHarness({
      store: memoryStore({ agentsEnabled: true }),
      transport: replayTransport(rec),
    });
    const run = await harness.startRun({ kind: "extraction-replay", ref: id });
    const result: ExtractionResult = await extractDocument({
      harness,
      run,
      step: "extract:m2-run",
      document: { kind: kind as "invoice", mime: "application/pdf", bytes },
    });
    if (result.status !== "EXTRACTED") {
      throw new Error(`${id}: replayed extraction failed (${JSON.stringify(result.failure)})`);
    }
    const v = await insertFactsVersion(repo, {
      documentId: stored.document.id as DocumentId,
      source: "model",
      status: "EXTRACTED",
      textLayer: true,
      facts: result.facts,
    });
    versionUuid.set(id, v.version.id);
  }

  // 2. The two payments, with the transfer id and final status the recorded webhooks report.
  const hold = readJson<HoldView>(HOLD_VIEW);
  const transfers = [...recordedTransfers().values()];
  const byRef = (ref: string) => {
    const t = transfers.find((x) => x.reference === ref);
    if (!t) throw new Error(`no recorded transfer for ${ref}`);
    return t;
  };
  const strongRef = hold.payment.reference;
  const weakRef = transfers.map((t) => t.reference).find((r) => r && r !== strongRef);
  if (!weakRef) throw new Error("no second recorded transfer");
  const pay = async (name: string, ref: string, links: string[]) => {
    const t = byRef(ref);
    const counterparty = await createCounterparty(repo, { name, country: "US" });
    const minor = BigInt(Math.round((t.amount_beneficiary_receives ?? 0) * 100));
    const payment = await createPayment(repo, {
      counterpartyId: counterparty.id,
      amount: money(minor, "USD"),
      sourceCurrency: "USD",
      method: "SWIFT",
      reference: ref,
    });
    for (const id of links) {
      await attachEvidenceLink(repo, {
        paymentId: payment.id as PaymentId,
        documentId: docUuid.get(id) as DocumentId,
        createdBy: ownerId,
      });
    }
    await updatePaymentTransfer(repo, payment.id, {
      transferId: t.id,
      transferStatus: t.status,
      transferUpdatedAt: new Date(t.at),
    });
    return payment;
  };
  // Harbor: invoice, purchase order and contract (Strong). Lakeside: invoice only (Missing).
  const strong = await pay(hold.payment.counterparty, strongRef, [
    "inv-harbor-001",
    "po-harbor-001",
    "contract-harbor",
  ]);
  const weak = await pay("Lakeside Freight LLC", weakRef, ["inv-lakeside-001"]);

  // 3. The RFI on the Harbor transfer, its questions, and the model's draft (real handler).
  const set = readJson<{ rounds: { round: number; questions: SetQuestion[] }[] }>(
    `${DATASET}rfi-sets/rfi-set-harbor.json`,
  );
  const round1 = set.rounds.find((r) => r.round === 1);
  if (!round1) throw new Error("no round 1");
  const rfi = await insertRfi(repo, {
    airwallexRfiId: hold.rfi.airwallex_rfi_id,
    type: "TRANSACTION",
    subType: null,
    airwallexStatus: "ACTION_REQUIRED",
    airwallexUpdatedAt: new Date(hold.rfi.airwallex_updated_at),
    airwallexAnsweredRequests: 0,
    state: "DRAFTING",
    round: 1,
    expiresAt: new Date(hold.rfi.expires_at),
    paymentId: strong.id as PaymentId,
    orphanReason: null,
    linkedBy: "match",
    sourceKey: `replay:${hold.rfi.airwallex_rfi_id}`,
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
  const questions = await listRfiQuestions(repo, rfi.id, 1);
  const qIds = new Map(questions.map((r) => [r.airwallexQuestionId, r.id]));
  const jobId = await enqueueJob(db, {
    kind: RFI_DRAFT_JOB_KIND,
    payload: { businessId, rfiId: rfi.id, round: 1, replay: true },
  });
  const job = await getJob(db, jobId);
  if (!job) throw new Error("job missing");
  const ctx = { db, logger: memoryLogger() } as unknown as HandlerContext;
  await createRfiDraftHandler({ transport: draftReply(qIds, versionUuid, docUuid) })(
    { businessId, rfiId: rfi.id as RfiId, round: 1 },
    ctx,
    job,
  );

  // 4. The owner's own statement for the question the verifier rejected (recorded text), through the
  //    real owner-draft path (the verifier stores it OWNER_AUTHORED).
  const model = await getLatestDraft(repo, rfi.id as RfiId, 1);
  if (!model) throw new Error("the replayed draft was not stored");
  const answers = await listDraftAnswers(repo, model.id);
  const ownerAnswers = answers.map((a) => {
    const q = questions.find((x) => x.id === a.questionId);
    const recorded = hold.questions.find((h) => h.title === q?.title.en);
    if (a.status === "NEEDS_OWNER" && recorded?.answer.status === "OWNER_AUTHORED") {
      return { questionId: a.questionId, text: recorded.answer.text, ownerAuthored: true };
    }
    return {
      questionId: a.questionId,
      text: a.text,
      citations: [...a.citations],
      documentIds: [...a.documentIds],
    };
  });
  await createOwnerDraft(repo, {
    rfiId: rfi.id as RfiId,
    round: 1,
    parentDraftId: model.id,
    draftKey: `replay:${hold.rfi.airwallex_rfi_id}:owner`,
    userId: ownerId,
    answers: ownerAnswers,
  });

  // 5. The RFI's final recorded state (rfi.answered then rfi.closed in the live run).
  const end = recordedRfiEnd(hold.rfi.airwallex_rfi_id);
  if (end?.name === "rfi.closed") {
    await updateRfi(repo, rfi.id as RfiId, {
      state: "CLOSED",
      airwallexStatus: "CLOSED",
      airwallexUpdatedAt: new Date(end.at),
      airwallexAnsweredRequests: 1,
    });
  }

  // 6. Nothing queued for the replay business may run: the drafting handler publishes events.
  await db.execute(
    sql`UPDATE outbox_jobs SET status = 'DONE'
      WHERE status IN ('PENDING', 'RETRY') AND payload->>'businessId' = ${businessId}`,
  );

  return { strong: strong.id, weak: weak.id, rfi: rfi.id };
}

/** The recorded drafting reply with this database's ids in place of the live database's. */
function draftReply(
  qIds: Map<string, string>,
  versionUuid: Map<string, string>,
  docUuid: Map<string, string>,
): Transport {
  const rec = readJson<DraftRecording>(`${ANTHROPIC}drafting/rfi-set-harbor-m2-run-r1.json`);
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
