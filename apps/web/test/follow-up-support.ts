// Shared by apps/web/test/follow-up.int.test.ts and the follow-up Playwright seed (M3-05). Builds a REAL
// round 1 over the dataset and recorded responses: the dataset's PDFs are stored, their facts come from the
// extraction pipeline replaying the M2-02 recordings, round 1 is drafted by the real `rfi.draft` handler
// replaying the M2-05 recording, approved through the real approval path and recorded in answer memory.
// Round 2 of a follow-up RFI is then drafted by the same handler, so what a test or the e2e run sees is
// exactly what the product stores. No Airwallex or model call is made (the transport replays or counts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Transport } from "@carnet/agent";
import {
  consumeApproval,
  createCounterparty,
  createPayment,
  createUser,
  type Db,
  enqueueJob,
  getJob,
  getRfi,
  insertFactsVersion,
  insertRfi,
  insertRfiQuestions,
  listRfiQuestions,
  type RepoCtx,
  recordApprovedAnswers,
  repoCtx,
  storeDocument,
  updatePaymentTransfer,
  updateRfi,
} from "@carnet/db";
import {
  type ApprovalId,
  type BusinessId,
  type CounterpartyId,
  money,
  type PaymentId,
  type RfiId,
} from "@carnet/domain";
import { runExtractionForEval } from "../../../packages/agent/evals/drafting/facts";
import { loadDraftRecording } from "../../../packages/agent/evals/drafting/run";
import { buildApproveBody } from "../src/components/rfi/view";
import { approveRfiAnswer } from "../src/server/approvals";
import { loadHoldView } from "../src/server/hold";
import { memoryLogger } from "../src/server/log";
import { createRfiDraftHandler, RFI_DRAFT_JOB_KIND } from "../src/worker/handlers/draft";
import type { HandlerContext } from "../src/worker/handlers/index";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DATASET = `${ROOT}fixtures/dataset/`;
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
interface RfiSet {
  rounds: { round: number; questions: SetQuestion[] }[];
}

export const SET = "rfi-set-rhein-followup";
export const rhein = () => readJson<RfiSet>(`${DATASET}rfi-sets/${SET}.json`);

export interface Evidence {
  readonly docUuid: Map<string, string>;
  readonly versionUuid: Map<string, string>;
  /** The invoice document the purpose answer cites (its facts can be superseded to make an answer stale). */
  readonly invoiceDocumentId: string;
}

/** Stores the dataset's text PDFs and their extracted facts for the business of `repo`. */
export async function loadEvidence(repo: RepoCtx): Promise<Evidence> {
  const gt = readJson<{ documents: GtDocument[] }>(`${DATASET}ground-truth.json`);
  const extracted = await runExtractionForEval();
  const docUuid = new Map<string, string>();
  const versionUuid = new Map<string, string>();
  for (const d of gt.documents) {
    if (!d.file.endsWith(".pdf")) continue;
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
      bytes: new Uint8Array(readFileSync(`${DATASET}${d.file}`)),
    });
    docUuid.set(d.id, stored.document.id);
    const result = extracted.get(d.id);
    if (kind === "other" || result?.status !== "EXTRACTED") continue;
    const v = await insertFactsVersion(repo, {
      documentId: stored.document.id,
      source: "model",
      status: "EXTRACTED",
      textLayer: true,
      facts: result.facts,
    });
    versionUuid.set(d.id, v.version.id);
  }
  const invoiceDocumentId = docUuid.get("inv-rhein-001");
  if (!invoiceDocumentId) throw new Error("dataset has no inv-rhein-001");
  return { docUuid, versionUuid, invoiceDocumentId };
}

/** The recorded model reply with this database's ids in place of the recording's. */
export function recordedReply(
  recording: string,
  ev: Evidence,
  qIds: ReadonlyMap<string, string>,
): Transport {
  const rec = loadDraftRecording(recording);
  const call = rec.calls[0];
  if (!call) throw new Error("recording has no call");
  let text = JSON.stringify(call.response.content);
  text = text.replace(
    /([a-z0-9-]+)@1#(\d+)/g,
    (_m, doc: string, i: string) => `${ev.versionUuid.get(doc)}#${i}`,
  );
  for (const [doc, uuid] of ev.docUuid) text = text.replaceAll(`\\"${doc}\\"`, `\\"${uuid}\\"`);
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

/** A transport that records how many requests reached it (for "zero model calls"). */
export function countingTransport(inner: Transport): { transport: Transport; calls: () => number } {
  let n = 0;
  return {
    transport: async (...args) => {
      n += 1;
      return inner(...args);
    },
    calls: () => n,
  };
}

const ctxOf = (db: Db): HandlerContext =>
  ({ db, logger: memoryLogger() }) as unknown as HandlerContext;

export async function runDraftJob(
  db: Db,
  businessId: BusinessId,
  rfiId: RfiId,
  round: number,
  transport: Transport,
): Promise<void> {
  process.env.ANTHROPIC_API_KEY ||= "replay-not-a-key";
  const jobId = await enqueueJob(db, {
    kind: RFI_DRAFT_JOB_KIND,
    payload: { businessId, rfiId, round },
  });
  const job = await getJob(db, jobId);
  if (!job) throw new Error("job missing");
  await createRfiDraftHandler({ transport })({ businessId, rfiId, round }, ctxOf(db), job);
}

const suffix = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface Origin {
  readonly businessId: BusinessId;
  readonly counterpartyId: CounterpartyId;
  readonly rfiId: RfiId;
  readonly approvalId: ApprovalId;
  readonly approvalHash: string;
  readonly userId: string;
}

/**
 * Round 1 end to end: draft (recorded model reply), approval, the approval consumed and the RFI answered,
 * answers remembered. Returns the counterparty whose later follow-ups can reuse them.
 */
export async function seedApprovedRound1(
  db: Db,
  businessId: BusinessId,
  ev: Evidence,
  counterpartyName = "Rheinblick Druck GmbH",
): Promise<Origin> {
  const repo = repoCtx(db, businessId);
  const tag = suffix();
  const user = await createUser(repo, { email: `owner-${tag}@follow-up.test`, role: "owner" });
  const counterparty = await createCounterparty(repo, { name: counterpartyName, country: "DE" });
  const payment = await createPayment(repo, {
    counterpartyId: counterparty.id,
    amount: money(720000n, "EUR"),
    sourceCurrency: "USD",
    method: "SWIFT",
    reference: `RD-${tag}`,
  });
  await updatePaymentTransfer(repo, payment.id, {
    transferId: `tr_follow_up_${tag}`,
    transferStatus: "PROCESSING",
    transferUpdatedAt: new Date(),
  });
  const rfi = await insertRfi(repo, {
    airwallexRfiId: `follow-up-origin-${tag}`,
    type: "TRANSACTION",
    subType: null,
    airwallexStatus: "ACTION_REQUIRED",
    airwallexUpdatedAt: new Date(Date.now() - 120_000),
    airwallexAnsweredRequests: 0,
    state: "DRAFTING",
    round: 1,
    expiresAt: new Date(Date.now() + 48 * 3_600_000),
    paymentId: payment.id as PaymentId,
    orphanReason: null,
    linkedBy: "match",
    sourceKey: `follow-up:origin:${tag}`,
    conflict: false,
  });
  const round1 = rhein().rounds.find((r) => r.round === 1);
  if (!round1) throw new Error("no round 1");
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
  await runDraftJob(db, businessId, rfi.id, 1, recordedReply(`${SET}-r1`, ev, qIds));

  const stored = await getRfi(repo, rfi.id);
  if (!stored) throw new Error("rfi vanished");
  const view = await loadHoldView(repo, stored, "owner");
  const body = buildApproveBody(view) as unknown as
    | Parameters<typeof approveRfiAnswer>[0]["body"]
    | null;
  if (!body) throw new Error("round 1 has no draft");
  const res = await approveRfiAnswer(
    { repo, userId: user.id, rfiId: rfi.id, body, key: `origin-${tag}`, requestId: `req-${tag}` },
    { executionEnabled: async () => true },
  );
  if (res.status !== 201) throw new Error(`approve failed: ${res.status} ${await res.text()}`);
  const approval = ((await res.json()) as { approval: { id: string; hash: string } }).approval;
  const consumed = await consumeApproval(repo, {
    approvalId: approval.id as ApprovalId,
    expectedHash: approval.hash,
  });
  if (consumed.outcome !== "consumed") throw new Error(`consume refused: ${consumed.reason}`);
  await updateRfi(repo, rfi.id, { state: "ANSWERED", airwallexAnsweredRequests: 1 });
  const memory = await recordApprovedAnswers(repo, {
    rfiId: rfi.id,
    approvalId: approval.id as ApprovalId,
  });
  if (memory.skipped) throw new Error(`memory skipped: ${memory.skipped}`);
  return {
    businessId,
    counterpartyId: counterparty.id,
    rfiId: rfi.id,
    approvalId: approval.id as ApprovalId,
    approvalHash: approval.hash,
    userId: user.id,
  };
}

export interface Round2Question {
  /** The Airwallex question id: the round-1 id when reopened, a new one when appended. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly answerType: "TEXT" | "ATTACHMENT";
  readonly reopened: boolean;
}

/** The recorded round 1 purpose question, reopened unchanged. */
export const purposeReopened = (): Round2Question => {
  const q = rhein().rounds[0]?.questions.find((x) => x.id === "q-rhein-purpose");
  if (!q) throw new Error("no purpose question");
  return {
    id: q.id,
    title: q.title.en,
    description: q.description.en,
    answerType: "TEXT",
    reopened: true,
  };
};

/** The recorded round 2 appended question (`q-rhein-r2-end_use`). */
export const endUseAppended = (): Round2Question => {
  const q = rhein().rounds[1]?.questions.find((x) => x.id === "q-rhein-r2-end_use");
  if (!q) throw new Error("no end-use question");
  return {
    id: q.id,
    title: q.title.en,
    description: q.description.en,
    answerType: "TEXT",
    reopened: false,
  };
};

export interface FollowUpRfi {
  readonly rfiId: RfiId;
  readonly paymentId: PaymentId;
  /** Carnet question row ids of round 2, by Airwallex question id. */
  readonly qIds: Map<string, string>;
}

/**
 * A new RFI of the same counterparty that Airwallex has reopened: round 1 rows (answered, nothing to
 * draft) and the round 2 questions, state DRAFTING round 2, ready for the `rfi.draft` job.
 */
export async function seedFollowUpRfi(
  db: Db,
  origin: Origin,
  questions: readonly Round2Question[],
  reference: string,
): Promise<FollowUpRfi> {
  const repo = repoCtx(db, origin.businessId);
  const tag = suffix();
  const payment = await createPayment(repo, {
    counterpartyId: origin.counterpartyId,
    amount: money(450000n, "EUR"),
    sourceCurrency: "USD",
    method: "SWIFT",
    reference,
  });
  await updatePaymentTransfer(repo, payment.id, {
    transferId: `tr_follow_up_${tag}`,
    transferStatus: "PROCESSING",
    transferUpdatedAt: new Date(),
  });
  const rfi = await insertRfi(repo, {
    airwallexRfiId: `follow-up-${tag}`,
    type: "TRANSACTION",
    subType: null,
    airwallexStatus: "ACTION_REQUIRED",
    airwallexUpdatedAt: new Date(Date.now() - 60_000),
    airwallexAnsweredRequests: 1,
    state: "DRAFTING",
    round: 2,
    expiresAt: new Date(Date.now() + 28 * 3_600_000),
    paymentId: payment.id as PaymentId,
    orphanReason: null,
    linkedBy: "match",
    sourceKey: `follow-up:${tag}`,
    conflict: false,
  });
  const round1 = rhein().rounds.find((r) => r.round === 1);
  if (!round1) throw new Error("no round 1");
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
      needsDrafting: false,
    })),
  );
  await insertRfiQuestions(
    repo,
    rfi.id,
    questions.map((q, position) => ({
      round: 2,
      airwallexQuestionId: q.id,
      position,
      title: { en: q.title, zh: null },
      description: { en: q.description, zh: null },
      comment: null,
      answerType: q.answerType,
      sources: [],
      reopened: q.reopened,
      needsDrafting: true,
    })),
  );
  const rows = await listRfiQuestions(repo, rfi.id, 2);
  return {
    rfiId: rfi.id,
    paymentId: payment.id as PaymentId,
    qIds: new Map(rows.map((r) => [r.airwallexQuestionId, r.id])),
  };
}
