// ADR 0012 cross-tenant tests. Every tenant repository function (every export of src/repos that is
// not a system function or a context helper) must take `ctx` first and have a case below in which
// business A's context cannot read, update or delete business B's rows. A new repository function
// without a case, or without `ctx` first, fails this file.
import { createHash } from "node:crypto";
import {
  type ApprovalId,
  type AttemptId,
  type BusinessId,
  type CounterpartyId,
  type DocumentId,
  money,
  newPaymentId,
  newRequestId,
  nextRevision,
  type PaymentId,
  type PlanInputsInput,
  type RequestId,
  type RfiId,
  type UserId,
} from "@carnet/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { ForeignKeyViolationError } from "../src/errors";
import * as agentStore from "../src/repos/agent-store";
import * as approvalSweeps from "../src/repos/approval-sweeps";
import * as attempts from "../src/repos/attempts";
import * as context from "../src/repos/context";
import * as repos from "../src/repos/index";
import * as outbox from "../src/repos/outbox";
import * as payeeLinkLookup from "../src/repos/payee-link-lookup";
import * as rateLimits from "../src/repos/rate-limits";
import * as rfiAttribution from "../src/repos/rfi-attribution";
import * as system from "../src/repos/system";
import * as webhookEvents from "../src/repos/webhook-events";
import * as workerHeartbeats from "../src/repos/worker-heartbeats";
import { useTestDatabase } from "./harness";

const db = useTestDatabase();

type RepoFn = (...args: never[]) => unknown;
// System modules take `db`: provider and platform tables (rate_limits has no business_id; its keys
// name the route and subject), and the worker's reconciler lookups
// (attempts.ts), which return the owning business id so the caller continues with a tenant context.
// agent-store.ts only composes the agent-runs functions below for @carnet/agent (its methods are
// proven per business in agent-runs.int.test.ts).
const helperNames = new Set([
  ...Object.keys(agentStore),
  ...Object.keys(approvalSweeps),
  ...Object.keys(context),
  ...Object.keys(system),
  ...Object.keys(outbox),
  ...Object.keys(payeeLinkLookup),
  ...Object.keys(rateLimits),
  ...Object.keys(rfiAttribution),
  ...Object.keys(webhookEvents),
  ...Object.keys(workerHeartbeats),
  ...Object.keys(attempts),
  "effectiveApprovalStatus", // repos/approvals: a pure reader of a row already loaded
  "toAttempt", // repos/execution-attempts: row mapper used by consumeApproval
  "sha256Hex", // repos/documents: a pure hash helper, no table access
]);
const tenantRepoFns: [string, RepoFn][] = Object.entries(repos as Record<string, unknown>).filter(
  (e): e is [string, RepoFn] => typeof e[1] === "function" && !helperNames.has(e[0]),
);

interface Fixture {
  businessId: BusinessId;
  userId: UserId;
  counterpartyId: CounterpartyId;
  paymentId: PaymentId;
  attemptId: AttemptId;
  requestId: RequestId;
  documentId: DocumentId;
  agentRunId: string;
  agentStepId: string;
  rfiId: RfiId;
  transferId: string;
  approvalId: ApprovalId;
  approvalHash: string;
  linkId: string;
}

/** An empty plan for a business: enough to give every tenant a stored revision. */
function emptyPlanInputs(businessId: string): PlanInputsInput {
  return {
    businessId,
    now: "2026-11-04T09:00:00.000Z",
    balances: [],
    held: [],
    obligations: [],
    reserveFloor: [],
    fxRates: [],
    config: {
      swiftPayoutFee: [],
      fxSpreadBps: 0,
      heldFundsVisibleInBalances: true,
      deferGraceDays: { "2": 1, "3": 1 },
    },
    policy: { version: 1, hash: "p", autoConvertLimits: [] },
  };
}

const ENDPOINT = "POST /api/v1/payments";
const KEY = "same-key-in-both";

async function seed(name: string): Promise<Fixture> {
  const { app } = db();
  const businessId = await system.createBusiness(app.db, { name });
  const ctx = repos.repoCtx(app.db, businessId);
  const user = await repos.createUser(ctx, { email: `owner@${name}.test`, role: "owner" });
  const cp = await repos.createCounterparty(ctx, { name: `${name} supplier`, country: "SG" });
  const payment = await repos.createPayment(ctx, {
    counterpartyId: cp.id,
    amount: money(12_345n, "USD"),
    sourceCurrency: "USD",
    method: "SWIFT",
    reference: name,
  });
  const requestId = newRequestId();
  const attempt = await repos.createAttempt(ctx, {
    kind: "transfer",
    refId: payment.id,
    requestId,
  });
  await repos.saveIdempotencyRecord(ctx, {
    endpoint: ENDPOINT,
    key: KEY,
    requestHash: `hash-${name}`,
    responseStatus: 201,
    response: { business: name },
  });
  await repos.appendAudit(ctx, { actorType: "user", action: "seed", subject: name });
  const doc = await repos.storeDocument(ctx, {
    kind: "invoice",
    filename: `${name}.pdf`,
    mime: "application/pdf",
    bytes: new TextEncoder().encode(`%PDF-1.7 ${name}\n%%EOF`),
  });
  await repos.insertFactsVersion(ctx, {
    documentId: doc.document.id,
    source: "model",
    status: "EXTRACTED",
    textLayer: true,
    facts: [
      {
        key: "supplier",
        value: name,
        parsed: { type: "text", text: name },
        quote: `Supplier: ${name}`,
        page: 1,
        quote_verified: true,
        needs_confirmation: false,
        issues: [],
      },
    ],
  });
  const planInputs = emptyPlanInputs(businessId);
  await repos.insertPlanRevision(ctx, nextRevision(null, planInputs), { inputs: planInputs });
  const agentRun = await repos.createAgentRun(ctx, { kind: "draft", ref: "rfi-same-ref" });
  const agentStep = await repos.recordAgentStep(ctx, {
    runId: agentRun.id,
    step: "q1",
    promptVersion: "aaaaaaaaaaaa",
    model: "claude-sonnet-5-5",
    inputHash: "same-hash",
    outcome: "ok",
    output: { business: name },
    stopReason: "end_turn",
    inputTokens: 10,
    outputTokens: 5,
    costNanoUsd: 70_000,
    latencyMs: 1,
    providerRequestId: null,
  });
  if (!agentStep) throw new Error("seed: agent step not recorded");
  const transferId = `tr-${name}`;
  await repos.updatePaymentTransfer(ctx, payment.id, {
    transferId,
    transferStatus: "PROCESSING",
    transferUpdatedAt: new Date("2026-11-03T09:57:00Z"),
  });
  const rfi = await repos.insertRfi(ctx, {
    airwallexRfiId: `rfi-${name}`,
    type: "TRANSACTION",
    subType: null,
    airwallexStatus: "ACTION_REQUIRED",
    airwallexUpdatedAt: new Date("2026-11-03T09:57:38Z"),
    airwallexAnsweredRequests: 0,
    state: "DRAFTING",
    round: 1,
    expiresAt: null,
    paymentId: payment.id,
    orphanReason: null,
    linkedBy: "match",
    sourceKey: `TRANSFER:${transferId}`,
    conflict: false,
  });
  await repos.insertRfiQuestions(ctx, rfi.id, [question(`q-${name}`)]);
  const approvalHash = "b".repeat(64);
  const approval = await repos.createApproval(ctx, {
    kind: "rfi_answer",
    subjectRef: rfi.id,
    hash: approvalHash,
    nonce: `nonce-${name}`,
    approverId: user.id,
    expiresAt: new Date(Date.now() + 3_600_000),
    shownSnapshot: { business: name },
  });
  const link = await repos.createPayeeLink(ctx, {
    paymentId: payment.id,
    tokenHash: createHash("sha256").update(name).digest("hex"),
    expiresAt: new Date(Date.now() + 3_600_000),
    disclosureLevel: "GENERIC",
    createdBy: user.id,
  });
  if (!link) throw new Error("seed link not created");
  return {
    approvalId: approval.id,
    approvalHash,
    linkId: link.id,
    agentRunId: agentRun.id,
    agentStepId: agentStep.id,
    rfiId: rfi.id,
    transferId,
    businessId,
    userId: user.id,
    counterpartyId: cp.id,
    paymentId: payment.id,
    attemptId: attempt.id,
    requestId,
    documentId: doc.document.id,
  };
}

function question(id: string): repos.NewRfiQuestion {
  return {
    round: 1,
    airwallexQuestionId: id,
    position: 0,
    title: { en: "Purpose?", zh: null },
    description: { en: "Spike question", zh: null },
    comment: null,
    answerType: "TEXT",
    sources: [],
    reopened: false,
    needsDrafting: true,
  };
}

let A: Fixture;
let B: Fixture;
const ctxA = () => repos.repoCtx(db().app.db, A.businessId);
const ctxB = () => repos.repoCtx(db().app.db, B.businessId);

/** Everything business B owns, read through B's own context. */
async function snapshotB(): Promise<unknown> {
  const b = ctxB();
  return {
    business: await repos.getBusiness(b),
    users: await repos.listUsers(b),
    counterparties: await repos.listCounterparties(b),
    payments: await repos.listPayments(b),
    attempt: await repos.getAttempt(b, B.attemptId),
    idem: await repos.getIdempotencyRecord(b, ENDPOINT, KEY),
    audit: await repos.listAudit(b),
    documents: await repos.listDocuments(b),
    content: await repos.getDocumentContent(b, B.documentId),
    plans: await repos.listPlanRevisions(b),
    agentRun: await repos.getAgentRun(b, B.agentRunId),
    agentSteps: await repos.listAgentSteps(b, B.agentRunId),
    rfis: await repos.listRfis(b),
    questions: await repos.listRfiQuestions(b, B.rfiId),
    approval: await repos.getApproval(b, B.approvalId),
    payeeLinks: await repos.listPayeeLinks(b, B.paymentId),
  };
}

const ownedBy = (rows: readonly { businessId: BusinessId | null }[], id: BusinessId) =>
  rows.every((r) => r.businessId === id);

/** One case per tenant repository function: A's context must not reach B's rows. */
const cases: Record<string, () => Promise<void>> = {
  getBusiness: async () => {
    expect((await repos.getBusiness(ctxA()))?.id).toBe(A.businessId);
  },
  updateBusiness: async () => {
    const updated = await repos.updateBusiness(ctxA(), { name: "A renamed" });
    expect(updated?.id).toBe(A.businessId);
  },
  createUser: async () => {
    const u = await repos.createUser(ctxA(), { email: "new@a.test", role: "viewer" });
    expect(u.businessId).toBe(A.businessId);
  },
  getUser: async () => {
    expect(await repos.getUser(ctxA(), B.userId)).toBeNull();
  },
  listUsers: async () => {
    const rows = await repos.listUsers(ctxA());
    expect(rows.length).toBeGreaterThan(0);
    expect(ownedBy(rows, A.businessId)).toBe(true);
  },
  updateUserRole: async () => {
    expect(await repos.updateUserRole(ctxA(), B.userId, "viewer")).toBeNull();
  },
  deleteUser: async () => {
    expect(await repos.deleteUser(ctxA(), B.userId)).toBe(false);
  },
  createCounterparty: async () => {
    const c = await repos.createCounterparty(ctxA(), { name: "A new", country: "US" });
    expect(c.businessId).toBe(A.businessId);
  },
  getCounterparty: async () => {
    expect(await repos.getCounterparty(ctxA(), B.counterpartyId)).toBeNull();
  },
  listCounterparties: async () => {
    const rows = await repos.listCounterparties(ctxA());
    expect(rows.length).toBeGreaterThan(0);
    expect(ownedBy(rows, A.businessId)).toBe(true);
  },
  updateCounterparty: async () => {
    expect(await repos.updateCounterparty(ctxA(), B.counterpartyId, { name: "stolen" })).toBeNull();
  },
  deleteCounterparty: async () => {
    expect(await repos.deleteCounterparty(ctxA(), B.counterpartyId)).toBe(false);
  },
  createPayment: async () => {
    // A cannot attach B's counterparty to its own payment (composite foreign key).
    await expect(
      repos.createPayment(ctxA(), {
        counterpartyId: B.counterpartyId,
        amount: money(1n, "USD"),
        sourceCurrency: "USD",
        method: "SWIFT",
        reference: "cross",
      }),
    ).rejects.toBeInstanceOf(ForeignKeyViolationError);
  },
  getPayment: async () => {
    expect(await repos.getPayment(ctxA(), B.paymentId)).toBeNull();
  },
  getPaymentForUpdate: async () => {
    const { app } = db();
    const found = await app.db.transaction((tx) =>
      repos.getPaymentForUpdate(repos.repoCtx(tx, A.businessId), B.paymentId),
    );
    expect(found).toBeNull();
  },
  listPayments: async () => {
    const rows = await repos.listPayments(ctxA());
    expect(rows.length).toBeGreaterThan(0);
    expect(ownedBy(rows, A.businessId)).toBe(true);
  },
  updatePaymentTransfer: async () => {
    const r = await repos.updatePaymentTransfer(ctxA(), B.paymentId, {
      transferId: "tr_stolen",
      transferStatus: "PAID",
      transferUpdatedAt: new Date(),
    });
    expect(r).toBeNull();
  },
  createAttempt: async () => {
    const a = await repos.createAttempt(ctxA(), {
      kind: "respond",
      refId: newPaymentId(),
      requestId: newRequestId(),
    });
    expect(a.businessId).toBe(A.businessId);
  },
  getAttempt: async () => {
    expect(await repos.getAttempt(ctxA(), B.attemptId)).toBeNull();
  },
  getAttemptByRequestId: async () => {
    expect(await repos.getAttemptByRequestId(ctxA(), B.requestId)).toBeNull();
  },
  listAttemptsForRefs: async () => {
    // B's payment id asked through A's context returns nothing; A's own is found.
    expect(await repos.listAttemptsForRefs(ctxA(), "transfer", [B.paymentId])).toEqual([]);
    const own = await repos.listAttemptsForRefs(ctxA(), "transfer", [A.paymentId, B.paymentId]);
    expect(own.map((a) => a.id)).toEqual([A.attemptId]);
  },
  listWebhookEventsForPayment: async () => {
    expect(await repos.listWebhookEventsForPayment(ctxA(), B.paymentId)).toEqual([]);
  },
  updateAttemptStatus: async () => {
    expect(await repos.updateAttemptStatus(ctxA(), B.attemptId, "REJECTED")).toBeNull();
  },
  getIdempotencyRecord: async () => {
    // Same endpoint and key in both businesses: A sees only its own record.
    const r = await repos.getIdempotencyRecord(ctxA(), ENDPOINT, KEY);
    expect(r?.businessId).toBe(A.businessId);
    expect(r?.response).toEqual({ business: "a-co" });
  },
  saveIdempotencyRecord: async () => {
    const r = await repos.saveIdempotencyRecord(ctxA(), {
      endpoint: ENDPOINT,
      key: "only-in-a",
      requestHash: "h",
      responseStatus: 200,
      response: {},
    });
    expect(r.businessId).toBe(A.businessId);
  },
  createPayeeLink: async () => {
    // A cannot create a link for B's payment; nothing is written.
    const r = await repos.createPayeeLink(ctxA(), {
      paymentId: B.paymentId,
      tokenHash: createHash("sha256").update("cross").digest("hex"),
      expiresAt: new Date(Date.now() + 3_600_000),
      disclosureLevel: "GENERIC",
      createdBy: A.userId,
    });
    expect(r).toBeNull();
  },
  listPayeeLinks: async () => {
    expect(await repos.listPayeeLinks(ctxA(), B.paymentId)).toEqual([]);
    const own = await repos.listPayeeLinks(ctxA(), A.paymentId);
    expect(own.length).toBeGreaterThan(0);
    expect(ownedBy(own, A.businessId)).toBe(true);
  },
  revokePayeeLink: async () => {
    expect(await repos.revokePayeeLink(ctxA(), B.paymentId, B.linkId)).toBeNull();
    // Right link id, wrong payment: still not found.
    expect(await repos.revokePayeeLink(ctxA(), A.paymentId, B.linkId)).toBeNull();
  },
  appendAudit: async () => {
    const e = await repos.appendAudit(ctxA(), { actorType: "user", action: "x", subject: "y" });
    expect(e.businessId).toBe(A.businessId);
  },
  createApproval: async () => {
    const a = await repos.createApproval(ctxA(), {
      kind: "rfi_answer",
      subjectRef: A.rfiId,
      hash: "c".repeat(64),
      nonce: "nonce-a-second",
      approverId: A.userId,
      expiresAt: new Date(Date.now() + 3_600_000),
      shownSnapshot: {},
    });
    expect(a.businessId).toBe(A.businessId);
    // It superseded A's earlier live approval only; B's is untouched.
    expect((await repos.getApproval(ctxB(), B.approvalId))?.status).toBe("APPROVED");
  },
  listApprovalsForSubject: async () => {
    expect(await repos.listApprovalsForSubject(ctxA(), "rfi_answer", B.rfiId)).toEqual([]);
  },
  getApproval: async () => {
    expect(await repos.getApproval(ctxA(), B.approvalId)).toBeNull();
  },
  getLiveApprovalForSubject: async () => {
    expect(await repos.getLiveApprovalForSubject(ctxA(), "rfi_answer", B.rfiId)).toBeNull();
  },
  endApproval: async () => {
    expect(
      await repos.endApproval(ctxA(), B.approvalId, "REJECTED", "REJECTED_BY_USER"),
    ).toBeNull();
  },
  consumeApproval: async () => {
    const r = await repos.consumeApproval(ctxA(), {
      approvalId: B.approvalId,
      expectedHash: B.approvalHash,
    });
    expect(r).toEqual({ outcome: "refused", reason: "NOT_FOUND" });
  },
  getRfi: async () => {
    expect(await repos.getRfi(ctxA(), B.rfiId)).toBeNull();
  },
  getRfiForUpdate: async () => {
    const found = await db().app.db.transaction((tx) =>
      repos.getRfiForUpdate(repos.repoCtx(tx, A.businessId), B.rfiId),
    );
    expect(found).toBeNull();
  },
  getRfiByAirwallexIdForUpdate: async () => {
    const found = await db().app.db.transaction((tx) =>
      repos.getRfiByAirwallexIdForUpdate(repos.repoCtx(tx, A.businessId), "rfi-b-co"),
    );
    expect(found).toBeNull();
  },
  listRfis: async () => {
    const rows = await repos.listRfis(ctxA());
    expect(rows.length).toBeGreaterThan(0);
    expect(ownedBy(rows, A.businessId)).toBe(true);
    expect(await repos.listRfis(ctxA(), { paymentId: B.paymentId })).toEqual([]);
  },
  insertRfi: async () => {
    const r = await repos.insertRfi(ctxA(), {
      airwallexRfiId: "rfi-b-co", // the same Airwallex id as B's: unique per business only
      type: "TRANSACTION",
      subType: null,
      airwallexStatus: "ACTION_REQUIRED",
      airwallexUpdatedAt: new Date(),
      airwallexAnsweredRequests: 0,
      state: "ACTION_REQUIRED",
      round: 1,
      expiresAt: null,
      paymentId: null,
      orphanReason: "NO_SOURCES",
      linkedBy: null,
      sourceKey: null,
      conflict: false,
    });
    expect(r.businessId).toBe(A.businessId);
  },
  updateRfi: async () => {
    expect(await repos.updateRfi(ctxA(), B.rfiId, { state: "EXPIRED" })).toBeNull();
  },
  findOpenRfiBySourceKey: async () => {
    const found = await repos.findOpenRfiBySourceKey(ctxA(), {
      type: "TRANSACTION",
      sourceKey: `TRANSFER:${B.transferId}`,
    });
    expect(found).toBeNull();
  },
  linkRfiToPayment: async () => {
    // A cannot link B's RFI, nor link its own RFI to B's payment.
    expect(await repos.linkRfiToPayment(ctxA(), B.rfiId, A.paymentId)).toBeNull();
    const own = await db().app.db.transaction((tx) =>
      repos.linkRfiToPayment(repos.repoCtx(tx, A.businessId), A.rfiId, B.paymentId),
    );
    expect(own).toBeNull();
  },
  unlinkRfi: async () => {
    expect(await repos.unlinkRfi(ctxA(), B.rfiId)).toBeNull();
  },
  insertRfiQuestions: async () => {
    expect(await repos.insertRfiQuestions(ctxA(), B.rfiId, [question("stolen")])).toBe(0);
  },
  listRfiQuestions: async () => {
    expect(await repos.listRfiQuestions(ctxA(), B.rfiId)).toEqual([]);
  },
  paymentIdsByTransferIds: async () => {
    const map = await repos.paymentIdsByTransferIds(ctxA(), [B.transferId, A.transferId]);
    expect([...map.values()]).toEqual([A.paymentId]);
  },
  paymentHasHoldingRfi: async () => {
    expect(await repos.paymentHasHoldingRfi(ctxA(), B.paymentId)).toBe(false);
    expect(await repos.paymentHasHoldingRfi(ctxA(), A.paymentId)).toBe(true);
  },
  listAudit: async () => {
    const rows = await repos.listAudit(ctxA());
    expect(rows.length).toBeGreaterThan(0);
    expect(ownedBy(rows, A.businessId)).toBe(true);
  },
  storeDocument: async () => {
    // A uploads the exact bytes B holds: A gets its own row, never B's (dedupe is per business).
    const bBytes = (await repos.getDocumentContent(ctxB(), B.documentId))?.bytes;
    expect(bBytes).toBeDefined();
    const r = await repos.storeDocument(ctxA(), {
      kind: "other",
      filename: "copy.pdf",
      mime: "application/pdf",
      bytes: bBytes ?? new Uint8Array(1),
    });
    expect(r.deduplicated).toBe(false);
    expect(r.document.businessId).toBe(A.businessId);
    expect(r.document.id).not.toBe(B.documentId);
  },
  getDocument: async () => {
    expect(await repos.getDocument(ctxA(), B.documentId)).toBeNull();
    expect((await repos.getDocument(ctxA(), A.documentId))?.businessId).toBe(A.businessId);
  },
  getDocumentContent: async () => {
    expect(await repos.getDocumentContent(ctxA(), B.documentId)).toBeNull();
  },
  findDocumentBySha256: async () => {
    const b = await repos.getDocument(ctxB(), B.documentId);
    const found = await repos.findDocumentBySha256(ctxA(), b?.sha256 ?? "");
    expect(found === null || found.businessId === A.businessId).toBe(true);
  },
  listDocuments: async () => {
    const rows = await repos.listDocuments(ctxA());
    expect(rows.length).toBeGreaterThan(0);
    expect(ownedBy(rows, A.businessId)).toBe(true);
  },
  insertFactsVersion: async () => {
    // A cannot attach facts to B's document: the composite key refuses it, and nothing is written.
    await expect(
      repos.insertFactsVersion(ctxA(), {
        documentId: B.documentId,
        source: "model",
        status: "EXTRACTED",
        textLayer: true,
        facts: [],
      }),
    ).rejects.toMatchObject({ name: "ForeignKeyViolationError" });
    expect(await repos.listFactVersions(ctxB(), B.documentId)).toHaveLength(1);
  },
  getFactsVersion: async () => {
    expect(await repos.getFactsVersion(ctxA(), B.documentId, 1)).toBeNull();
    expect((await repos.getFactsVersion(ctxA(), A.documentId, 1))?.documentId).toBe(A.documentId);
  },
  getLatestFacts: async () => {
    expect(await repos.getLatestFacts(ctxA(), B.documentId)).toBeNull();
    expect((await repos.getLatestFacts(ctxA(), A.documentId))?.documentId).toBe(A.documentId);
  },
  listFactVersions: async () => {
    expect(await repos.listFactVersions(ctxA(), B.documentId)).toEqual([]);
    expect(await repos.listFactVersions(ctxA(), A.documentId)).toHaveLength(1);
  },
  getUsableFacts: async () => {
    expect(await repos.getUsableFacts(ctxA(), B.documentId)).toBeNull();
    expect((await repos.getUsableFacts(ctxA(), A.documentId))?.document_id).toBe(A.documentId);
  },
  insertPlanRevision: async () => {
    const inputs = emptyPlanInputs(B.businessId);
    // B's plan cannot be written through A's context.
    await expect(
      repos.insertPlanRevision(ctxA(), nextRevision(null, inputs), { inputs }),
    ).rejects.toThrow(/another business/);
  },
  getLatestPlan: async () => {
    expect((await repos.getLatestPlan(ctxA()))?.plan.business_id).toBe(A.businessId);
  },
  getPlanByRevision: async () => {
    expect((await repos.getPlanByRevision(ctxA(), 1))?.plan.business_id).toBe(A.businessId);
    expect(await repos.getPlanByRevision(ctxA(), 99)).toBeNull();
  },
  listPlanRevisions: async () => {
    const rows = await repos.listPlanRevisions(ctxA());
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.plan.business_id === A.businessId)).toBe(true);
  },
  createAgentRun: async () => {
    const r = await repos.createAgentRun(ctxA(), { kind: "draft", ref: "rfi-same-ref" });
    expect(r.businessId).toBe(A.businessId);
  },
  getAgentRun: async () => {
    expect(await repos.getAgentRun(ctxA(), B.agentRunId)).toBeNull();
  },
  finishAgentRun: async () => {
    expect(await repos.finishAgentRun(ctxA(), B.agentRunId, "FAILED")).toBeNull();
  },
  recordAgentStep: async () => {
    // A step on B's run through A's context writes nothing (and does not touch B's totals).
    const r = await repos.recordAgentStep(ctxA(), {
      runId: B.agentRunId,
      step: "stolen",
      promptVersion: "bbbbbbbbbbbb",
      model: "claude-haiku-5-5",
      inputHash: "h",
      outcome: "ok",
      output: {},
      stopReason: "end_turn",
      inputTokens: 1,
      outputTokens: 1,
      costNanoUsd: 600,
      latencyMs: 1,
      providerRequestId: null,
    });
    expect(r).toBeNull();
  },
  listAgentSteps: async () => {
    expect(await repos.listAgentSteps(ctxA(), B.agentRunId)).toEqual([]);
    const own = await repos.listAgentSteps(ctxA(), A.agentRunId);
    expect(own.length).toBeGreaterThan(0);
    expect(ownedBy(own, A.businessId)).toBe(true);
  },
  findReplayableAgentStep: async () => {
    // Same kind, ref, step, hash and version in both businesses: A replays only its own output.
    const hit = await repos.findReplayableAgentStep(ctxA(), {
      kind: "draft",
      ref: "rfi-same-ref",
      step: "q1",
      inputHash: "same-hash",
      promptVersion: "aaaaaaaaaaaa",
    });
    expect(hit?.id).toBe(A.agentStepId);
    expect(hit?.output).toEqual({ business: "a-co" });
  },
  countAgentCalls: async () => {
    const n = await repos.countAgentCalls(ctxA(), {
      kind: "draft",
      ref: "rfi-same-ref",
      step: "q1",
    });
    expect(n).toBe(1);
  },
};

describe("tenant repository registry", () => {
  it("finds the tenant repository functions", () => {
    expect(tenantRepoFns.length).toBeGreaterThanOrEqual(20);
  });

  it.each(tenantRepoFns)("%s takes `ctx` as its first parameter", (_name, fn) => {
    expect(fn.toString()).toMatch(/^async function \w+\(\s*ctx\s*[,)]/);
  });

  it.each(tenantRepoFns)("%s has a cross-tenant case", (name) => {
    expect(Object.keys(cases)).toContain(name);
  });

  it("every case names a real repository function", () => {
    expect(Object.keys(cases).sort()).toEqual(tenantRepoFns.map(([n]) => n).sort());
  });
});

describe("cross-tenant isolation: business A's context against business B's rows", () => {
  let before: unknown;
  beforeAll(async () => {
    A = await seed("a-co");
    B = await seed("b-co");
    before = await snapshotB();
  });

  it.each(Object.entries(cases))("%s", async (_name, run) => {
    await run();
    expect(await snapshotB()).toEqual(before);
  });
});
