// ADR 0012 cross-tenant tests. Every tenant repository function (every export of src/repos that is
// not a system function or a context helper) must take `ctx` first and have a case below in which
// business A's context cannot read, update or delete business B's rows. A new repository function
// without a case, or without `ctx` first, fails this file.
import {
  type AttemptId,
  type BusinessId,
  type CounterpartyId,
  type DocumentId,
  money,
  newPaymentId,
  newRequestId,
  type PaymentId,
  type RequestId,
  type UserId,
} from "@carnet/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { ForeignKeyViolationError } from "../src/errors";
import * as attempts from "../src/repos/attempts";
import * as context from "../src/repos/context";
import * as repos from "../src/repos/index";
import * as outbox from "../src/repos/outbox";
import * as rateLimits from "../src/repos/rate-limits";
import * as system from "../src/repos/system";
import * as webhookEvents from "../src/repos/webhook-events";
import * as workerHeartbeats from "../src/repos/worker-heartbeats";
import { useTestDatabase } from "./harness";

const db = useTestDatabase();

type RepoFn = (...args: never[]) => unknown;
// System modules take `db`: provider and platform tables (rate_limits has no business_id; its keys
// name the route and subject), and the worker's reconciler lookups
// (attempts.ts), which return the owning business id so the caller continues with a tenant context.
const helperNames = new Set([
  ...Object.keys(context),
  ...Object.keys(system),
  ...Object.keys(outbox),
  ...Object.keys(rateLimits),
  ...Object.keys(webhookEvents),
  ...Object.keys(workerHeartbeats),
  ...Object.keys(attempts),
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
  return {
    businessId,
    userId: user.id,
    counterpartyId: cp.id,
    paymentId: payment.id,
    attemptId: attempt.id,
    requestId,
    documentId: doc.document.id,
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
  appendAudit: async () => {
    const e = await repos.appendAudit(ctxA(), { actorType: "user", action: "x", subject: "y" });
    expect(e.businessId).toBe(A.businessId);
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
