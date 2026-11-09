// M2-05 on the web side: the `rfi.draft` job reads an RFI from Postgres, drafts through the agent harness
// from the real recorded model reply (re-keyed to this test's ids), verifies in code, stores an immutable
// draft, moves the RFI through the state machine with an audit row and publishes the draft event, in one
// transaction. Degradation never leaves an RFI in DRAFTING.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Transport } from "@carnet/agent";
import {
  createBusiness,
  type Db,
  enqueueJob,
  getJob,
  getRfi,
  insertFactsVersion,
  insertRfi,
  insertRfiQuestions,
  listAudit,
  listDraftAnswers,
  listDrafts,
  listRfiQuestions,
  repoCtx,
  schema,
  storeDocument,
} from "@carnet/db";
import type { BusinessId, RfiId } from "@carnet/domain";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { loadDraftingCases, loadDraftRecording } from "../../../packages/agent/evals/drafting/run";
import { runExtractionForEval } from "../../../packages/agent/evals/drafting/facts";
import { memoryLogger } from "../src/server/log";
import {
  createRfiDraftHandler,
  DRAFT_EVENT_KIND,
  RFI_DRAFT_JOB_KIND,
  sweepStuckDrafting,
} from "../src/worker/handlers/draft";
import type { HandlerContext } from "../src/worker/handlers/index";
import { webTestDatabase } from "./support";

const db = webTestDatabase();
process.env.ANTHROPIC_API_KEY ||= "replay-not-a-key";
const DATASET = fileURLToPath(new URL("../../../fixtures/dataset/", import.meta.url));

const SET = "rfi-set-harbor-r1";
const DOCS: Record<string, { file: string; kind: string }> = {
  "inv-harbor-001": { file: "inv-harbor-001.pdf", kind: "invoice" },
  "po-harbor-001": { file: "po-harbor-001.pdf", kind: "purchase_order" },
  "contract-harbor": { file: "contract-harbor.pdf", kind: "contract" },
  "dn-harbor-001": { file: "dn-harbor-001.pdf", kind: "other" },
  "remit-brightline-001": { file: "remit-brightline-001.pdf", kind: "other" },
};

let businessId: BusinessId;
const docUuid = new Map<string, string>();
const versionUuid = new Map<string, string>();

function ctxOf(): HandlerContext {
  return { db: db().app.db, logger: memoryLogger() } as unknown as HandlerContext;
}

beforeAll(async () => {
  const { app } = db();
  businessId = await createBusiness(app.db, { name: "drafting-co" });
  const repo = repoCtx(app.db, businessId);
  const extracted = await runExtractionForEval();
  for (const [id, { file, kind }] of Object.entries(DOCS)) {
    const stored = await storeDocument(repo, {
      kind: kind as "invoice",
      filename: file,
      mime: "application/pdf",
      bytes: new Uint8Array(readFileSync(`${DATASET}${file}`)),
    });
    docUuid.set(id, stored.document.id);
    const result = extracted.get(id);
    if (kind !== "other" && result?.status === "EXTRACTED") {
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
});

/** A new DRAFTING RFI with the harbor set's four questions. Returns the id mapping for the reply. */
async function newRfi(tag: string): Promise<{ rfiId: RfiId; qIds: Map<string, string> }> {
  const repo = repoCtx(db().app.db, businessId);
  const set = (await loadDraftingCases()).find((c) => c.id === SET);
  if (!set) throw new Error("no case");
  const rfi = await insertRfi(repo, {
    airwallexRfiId: `rfi-${tag}`,
    type: "TRANSACTION",
    subType: null,
    airwallexStatus: "ACTION_REQUIRED",
    airwallexUpdatedAt: new Date("2026-11-03T09:57:38Z"),
    airwallexAnsweredRequests: 0,
    state: "DRAFTING",
    round: 1,
    expiresAt: null,
    paymentId: null,
    orphanReason: "NO_SOURCES",
    linkedBy: null,
    sourceKey: null,
    conflict: false,
  });
  await insertRfiQuestions(
    repo,
    rfi.id,
    set.questions.map((q, position) => ({
      round: 1,
      airwallexQuestionId: q.id,
      position,
      title: { en: q.title, zh: null },
      description: { en: q.description, zh: null },
      comment: null,
      answerType: q.answerType,
      sources: [],
      reopened: false,
      needsDrafting: true,
    })),
  );
  const rows = await listRfiQuestions(repo, rfi.id, 1);
  return { rfiId: rfi.id, qIds: new Map(rows.map((r) => [r.airwallexQuestionId, r.id])) };
}

/** The recorded model reply with its ids replaced by this database's. */
function replyFor(qIds: Map<string, string>): Transport {
  const rec = loadDraftRecording(SET);
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

async function runJob(rfiId: RfiId, transport: Transport, round = 1) {
  const jobId = await enqueueJob(db().app.db, {
    kind: RFI_DRAFT_JOB_KIND,
    payload: { businessId, rfiId, round },
  });
  const job = await getJob(db().app.db, jobId);
  if (!job) throw new Error("job missing");
  await createRfiDraftHandler({ transport })({ businessId, rfiId, round }, ctxOf(), job);
  return job;
}

const repo = () => repoCtx(db().app.db, businessId);

describe("AC1/AC6: a fully answerable RFI becomes DRAFT_READY with an immutable draft", () => {
  it("stores the draft, moves the RFI, audits the transition and publishes draft.ready", async () => {
    const { rfiId, qIds } = await newRfi("ready");
    const job = await runJob(rfiId, replyFor(qIds));

    const rfi = await getRfi(repo(), rfiId);
    expect(rfi?.state).toBe("DRAFT_READY");
    const drafts = await listDrafts(repo(), rfiId);
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    expect(draft).toMatchObject({
      origin: "model",
      state: "DRAFT_READY",
      round: 1,
      draftKey: job.id,
    });
    expect(draft?.blocking).toEqual([]);
    expect(draft?.promptVersion).toMatch(/^[0-9a-f]{12}$/);
    const answers = await listDraftAnswers(repo(), draft?.id ?? "");
    expect(answers).toHaveLength(4);
    expect(answers.every((a) => a.status === "VERIFIED")).toBe(true);
    expect(answers.filter((a) => a.citations.length > 0).length).toBe(2);
    expect(answers.flatMap((a) => a.documentIds).sort()).toEqual(
      [docUuid.get("dn-harbor-001"), docUuid.get("remit-brightline-001")].sort(),
    );

    const audit = (await listAudit(repo(), 200)).filter(
      (a) => a.subject === `rfi:${rfiId}` && a.action === "rfi.transition",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.data).toMatchObject({
      from: "DRAFTING",
      to: "DRAFT_READY",
      event: "draft.ready",
      source: "drafting",
    });

    const events = await db()
      .app.db.select()
      .from(schema.outboxJobs)
      .where(eq(schema.outboxJobs.kind, DRAFT_EVENT_KIND.ready));
    expect(events.some((e) => (e.payload as { draftId?: string }).draftId === draft?.id)).toBe(
      true,
    );
  });

  it("a retried or re-delivered job stores nothing more", async () => {
    const { rfiId, qIds } = await newRfi("retry");
    const transport = replyFor(qIds);
    await runJob(rfiId, transport);
    await runJob(rfiId, transport); // a second job for the same round: the RFI no longer awaits a draft
    expect(await listDrafts(repo(), rfiId)).toHaveLength(1);
    const audit = (await listAudit(repo(), 500)).filter(
      (a) => a.subject === `rfi:${rfiId}` && a.action === "rfi.transition",
    );
    expect(audit).toHaveLength(1);
  });
});

describe("AC4: degradation moves the RFI to NEEDS_OWNER, never leaves it in DRAFTING", () => {
  it("agents_enabled=false", async () => {
    const { rfiId, qIds } = await newRfi("disabled");
    await db()
      .app.db.update(schema.systemFlags)
      .set({ agentsEnabled: false })
      .where(eq(schema.systemFlags.id, 1));
    try {
      await runJob(rfiId, replyFor(qIds));
    } finally {
      await db()
        .app.db.update(schema.systemFlags)
        .set({ agentsEnabled: true })
        .where(eq(schema.systemFlags.id, 1));
    }
    expect((await getRfi(repo(), rfiId))?.state).toBe("NEEDS_OWNER");
    const [draft] = await listDrafts(repo(), rfiId);
    expect(draft?.state).toBe("NEEDS_OWNER");
    expect(draft?.blocking).toHaveLength(4);
    const answers = await listDraftAnswers(repo(), draft?.id ?? "");
    expect(answers.every((a) => a.reasonCode === "MODEL_UNAVAILABLE")).toBe(true);
    expect(answers.every((a) => a.text === "")).toBe(true);
  });

  it("a gap in the evidence: the RFI is NEEDS_OWNER and lists the blocking questions", async () => {
    // Drop the contract's facts view by drafting an RFI whose reply cites a fact that does not exist.
    const { rfiId, qIds } = await newRfi("bad-citation");
    const bad: Transport = async () =>
      new Response(
        JSON.stringify({
          id: "msg_x",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                answers: [...qIds.values()].map((q) => ({
                  question_id: q,
                  status: "answered",
                  text: "Invoice for USD 9,999.00.",
                  citations: [{ fact_version_id: "nope#0", quote: "x" }],
                  document_ids: [],
                })),
              }),
            },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    await runJob(rfiId, bad);
    expect((await getRfi(repo(), rfiId))?.state).toBe("NEEDS_OWNER");
    const [draft] = await listDrafts(repo(), rfiId);
    expect(draft?.blocking.map((b) => b.question_id).sort()).toEqual([...qIds.values()].sort());
  });

  it("the timeout sweeper moves an RFI stuck in DRAFTING and does nothing to one that has a draft", async () => {
    const stuck = await newRfi("stuck");
    const done = await newRfi("done");
    await runJob(done.rfiId, replyFor(done.qIds));
    const moved = await sweepStuckDrafting(ctxOf(), {
      now: new Date(Date.now() + 3_600_000),
      olderThanMs: 0,
    });
    expect(moved).toBeGreaterThanOrEqual(1);
    expect((await getRfi(repo(), stuck.rfiId))?.state).toBe("NEEDS_OWNER");
    const [sys] = await listDrafts(repo(), stuck.rfiId);
    expect(sys).toMatchObject({
      origin: "system",
      state: "NEEDS_OWNER",
      model: expect.any(String),
    });
    const answers = await listDraftAnswers(repo(), sys?.id ?? "");
    expect(
      answers.every(
        (a) => a.reasonCode === "MODEL_UNAVAILABLE" && a.verifierResult.detail === "draft_timeout",
      ),
    ).toBe(true);
    expect(await listDrafts(repo(), done.rfiId)).toHaveLength(1);
    expect((await getRfi(repo(), done.rfiId))?.state).toBe("DRAFT_READY");
    // A second sweep finds nothing more for them.
    await sweepStuckDrafting(ctxOf(), { now: new Date(Date.now() + 3_600_000), olderThanMs: 0 });
    expect(await listDrafts(repo(), stuck.rfiId)).toHaveLength(1);
  });
});

describe("AC10: event to draft time on a replayed run", () => {
  it("p95 of (draft step recorded - job enqueued) is below 60 s", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const { rfiId, qIds } = await newRfi(`lat-${i}`);
      const job = await runJob(rfiId, replyFor(qIds));
      const [draft] = await listDrafts(repo(), rfiId);
      const steps = await db()
        .app.db.select()
        .from(schema.agentSteps)
        .where(eq(schema.agentSteps.runId, draft?.agentRunId ?? ""));
      const step = steps[0];
      if (!step) throw new Error("no agent step");
      samples.push(step.createdAt.getTime() - job.createdAt.getTime());
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(0.95 * samples.length) - 1] ?? Number.POSITIVE_INFINITY;
    process.stderr.write(
      `event-to-draft p95 over ${samples.length} replayed runs: ${p95} ms (max ${samples.at(-1)} ms)\n`,
    );
    expect(p95).toBeLessThan(60_000);
  });
});

export type { Db };
