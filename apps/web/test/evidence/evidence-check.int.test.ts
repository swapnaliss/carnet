// M2-03: the evidence API on real route handlers (sessions, guards, tenant repositories). The check is
// computed by code from stored facts; the send guard refuses a Weak or Missing payment without the
// owner's acknowledgement and records an `evidence_override` audit entry when it is acknowledged.
import { readFileSync } from "node:fs";
import type { Balance } from "@carnet/airwallex";
import {
  createBusiness,
  createCounterparty,
  createPayment,
  type Db,
  insertFactsVersion,
  listAudit,
  repoCtx,
  storeDocument,
} from "@carnet/db";
import {
  ApiErrorSchema,
  type BusinessId,
  type DocumentId,
  EVIDENCE_REASON_KEYS,
  type ExtractedFact,
  money,
  type PaymentId,
} from "@carnet/domain";
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRouteKit, type RouteHandler } from "../../src/lib/define-route";
import { evidenceRouteSpecs } from "../../src/server/evidence";
import { createPaymentRoutes } from "../../src/server/payments";
import { t } from "../../src/strings";
import { addUser, ORIGIN, sessionCookie, setupAuthTestEnv } from "../auth/setup";

const env = setupAuthTestEnv();
const cookies = { owner: "", judge: "", otherOwner: "" };
let routes: ReturnType<typeof createPaymentRoutes>;
let evidence: { check: RouteHandler; attach: RouteHandler; detach: RouteHandler };
let counterpartyId: string;
let otherBusiness: BusinessId;
let foreignPayment: PaymentId;
let foreignDocument: DocumentId;

const usd = (minor: bigint): Balance => {
  const m = money(minor, "USD");
  return { currency: "USD", available: m, pending: m, reserved: m, total: m };
};

const pdf = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../../fixtures/dataset/${name}`, import.meta.url)));

const fact = (key: string, parsed: ExtractedFact["parsed"], over: Partial<ExtractedFact> = {}) =>
  ({
    key,
    value:
      parsed?.type === "text"
        ? parsed.text
        : parsed?.type === "amount"
          ? `USD ${parsed.minor}`
          : key,
    parsed,
    quote: `${key}: quoted text`,
    page: 1,
    quote_verified: true,
    needs_confirmation: false,
    issues: [],
    ...over,
  }) satisfies ExtractedFact;
const total = (minor: string) => fact("total", { type: "amount", minor, currency: "USD" });
const supplier = (name: string) => fact("supplier", { type: "text", text: name });

async function count(db: Db, table: string, businessId: BusinessId): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)} WHERE business_id = ${businessId}`,
  );
  return Number(rows.rows[0]?.n ?? 0);
}
const jobs = async (db: Db, kind: string) =>
  Number(
    (
      await db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM outbox_jobs WHERE kind = ${kind}`,
      )
    ).rows[0]?.n ?? 0,
  );

let docSeq = 0;
/** Stores a document of the business with one version of facts. */
async function addDocument(
  businessId: BusinessId,
  kind: "invoice" | "contract" | "purchase_order",
  facts: ExtractedFact[],
  file = "inv-harbor-001.pdf",
): Promise<DocumentId> {
  const ctx = repoCtx(env().db, businessId);
  const bytes = pdf(file);
  // Distinct bytes per call (the store de-duplicates identical bytes within a business).
  const unique = new Uint8Array(bytes.length + 1);
  unique.set(bytes);
  unique[bytes.length] = (docSeq++ % 250) + 1;
  const stored = await storeDocument(ctx, {
    kind,
    filename: `${kind}-${docSeq}.pdf`,
    mime: "application/pdf",
    bytes: unique,
  });
  await insertFactsVersion(ctx, {
    documentId: stored.document.id,
    source: "model",
    status: "EXTRACTED",
    textLayer: true,
    facts,
    extractionKey: `k-${stored.document.id}`,
  });
  return stored.document.id;
}

function call(
  route: RouteHandler,
  method: string,
  path: string,
  cookie: string,
  params: Record<string, string>,
  body?: unknown,
) {
  return route(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        cookie,
        origin: ORIGIN,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve(params) },
  );
}

const check = (cookie: string, id: string) =>
  call(evidence.check, "GET", `/api/v1/payments/${id}/evidence-check`, cookie, { id });
const attach = (cookie: string, id: string, documentId: string) =>
  call(
    evidence.attach,
    "POST",
    `/api/v1/payments/${id}/evidence-links`,
    cookie,
    { id },
    { document_id: documentId },
  );
const detach = (cookie: string, id: string, linkId: string) =>
  call(evidence.detach, "DELETE", `/api/v1/payments/${id}/evidence-links/${linkId}`, cookie, {
    id,
    linkId,
  });
const send = (cookie: string, id: string, b: unknown = {}) =>
  call(routes.send, "POST", `/api/v1/payments/${id}/send`, cookie, { id }, b);

async function newPayment(minor = 80_000n, reference = "INV-1"): Promise<PaymentId> {
  const { db, businessId } = env();
  return (
    await createPayment(repoCtx(db, businessId), {
      counterpartyId: counterpartyId as never,
      amount: money(minor, "USD"),
      sourceCurrency: "USD",
      method: "LOCAL",
      reference,
    })
  ).id;
}

beforeAll(async () => {
  const { db, passwords, businessId } = env();
  counterpartyId = (
    await createCounterparty(repoCtx(db, businessId), { name: "Harbor Print Co.", country: "US" })
  ).id;
  const kit = createRouteKit({
    authz: env().authz,
    db: () => db,
    logger: () => env().rt.logger,
    now: () => new Date(),
  });
  routes = createPaymentRoutes(kit, { balances: async () => [usd(10_000_000_00n)] });
  const specs = evidenceRouteSpecs();
  evidence = {
    check: kit.defineRoute(specs.check),
    attach: kit.defineRoute(specs.attach),
    detach: kit.defineRoute(specs.detach),
  };
  otherBusiness = await createBusiness(db, { name: "Business B (synthetic)" });
  foreignPayment = (
    await createPayment(repoCtx(db, otherBusiness), {
      amount: money(1000n, "USD"),
      sourceCurrency: "USD",
      method: "LOCAL",
      reference: "foreign-secret-reference",
    })
  ).id;
  foreignDocument = await addDocument(
    otherBusiness,
    "invoice",
    [total("1000")],
    "inv-lakeside-001.pdf",
  );
  await addUser(db, otherBusiness, {
    email: "owner@b.example",
    role: "owner",
    password: "b-owner-password",
  });
  cookies.owner = await sessionCookie(env(), "owner@carnet.example", passwords.owner);
  cookies.judge = await sessionCookie(env(), "judge@carnet.example", passwords.judge);
  cookies.otherOwner = await sessionCookie(env(), "owner@b.example", "b-owner-password");
});

beforeEach(async () => {
  const { db, businessId } = env();
  await db.execute(sql`DELETE FROM idempotency_keys WHERE business_id = ${businessId}`);
  await db.execute(sql`DELETE FROM execution_attempts WHERE business_id = ${businessId}`);
  await db.execute(sql`DELETE FROM evidence_links WHERE business_id = ${businessId}`);
  await db.execute(sql`DELETE FROM payments WHERE business_id = ${businessId}`);
  await db.execute(sql`DELETE FROM outbox_jobs`);
});

describe("GET evidence-check", () => {
  it("a payment with no documents is Missing, with the reason in words", async () => {
    const id = await newPayment();
    const res = await check(cookies.owner, id);
    expect(res.status).toBe(200);
    const dto = await res.json();
    expect(dto.flag).toBe("missing");
    expect(dto.reasons[0]).toMatchObject({ key: "noInvoice", text: t.evidence.reason.noInvoice });
    expect(dto.documents).toEqual([]);
    expect(dto.payment).toMatchObject({ sent: false, counterparty_name: "Harbor Print Co." });
    expect(dto.check_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an invoice that matches is Strong; the facts carry their quote and page", async () => {
    const id = await newPayment();
    const inv = await addDocument(env().businessId, "invoice", [
      total("80000"),
      supplier("Harbor Print Co."),
    ]);
    expect((await attach(cookies.owner, id, inv)).status).toBe(201);
    const dto = await (await check(cookies.judge, id)).json(); // any session may read
    expect(dto.flag).toBe("strong");
    const doc = dto.documents[0];
    expect(doc).toMatchObject({ kind: "invoice", extraction: "done", needs_confirmation: false });
    expect(doc.facts[0]).toMatchObject({
      key: "total",
      page: 1,
      quote: "total: quoted text",
      status: "verified",
      usable: true,
    });
    expect(dto.rules.map((r: { rule: string }) => r.rule)).toEqual([
      "R-AMT",
      "R-PAYEE",
      "R-VERIFIED",
    ]);
  });

  it("an unverified total never makes it Strong (it is Weak and says why)", async () => {
    const id = await newPayment();
    const inv = await addDocument(env().businessId, "invoice", [
      { ...total("80000"), quote_verified: false, issues: ["quote_not_found" as const] },
      supplier("Harbor Print Co."),
    ]);
    await attach(cookies.owner, id, inv);
    const dto = await (await check(cookies.owner, id)).json();
    expect(dto.flag).toBe("weak");
    expect(dto.reasons.map((r: { key: string }) => r.key)).toEqual(
      expect.arrayContaining(["amountNoFact", "unverifiedFact"]),
    );
    expect(dto.documents[0].facts[0].status).toBe("unverified");
  });

  it("every reason key and rule has words in the strings module", () => {
    for (const key of EVIDENCE_REASON_KEYS) {
      expect((t.evidence.reason as Record<string, string>)[key], key).toBeTruthy();
    }
  });
});

describe("evidence links", () => {
  it("attach is idempotent, snapshots a check, and detach removes it", async () => {
    const { db, businessId } = env();
    const id = await newPayment();
    const inv = await addDocument(businessId, "invoice", [
      total("80000"),
      supplier("Harbor Print Co."),
    ]);
    expect((await attach(cookies.owner, id, inv)).status).toBe(201);
    expect((await attach(cookies.owner, id, inv)).status).toBe(200);
    expect(await count(db, "evidence_links", businessId)).toBe(1);
    expect(await count(db, "evidence_checks", businessId)).toBeGreaterThanOrEqual(1);
    const dto = await (await check(cookies.owner, id)).json();
    const removed = await detach(cookies.owner, id, dto.documents[0].link_id);
    expect(removed.status).toBe(200);
    expect((await removed.json()).flag).toBe("missing");
    expect(await count(db, "evidence_links", businessId)).toBe(0);
    expect((await detach(cookies.owner, id, dto.documents[0].link_id)).status).toBe(404);
  });

  it("the viewer cannot attach or detach (403)", async () => {
    const id = await newPayment();
    const inv = await addDocument(env().businessId, "invoice", [total("80000")]);
    expect((await attach(cookies.judge, id, inv)).status).toBe(403);
    await attach(cookies.owner, id, inv);
    const dto = await (await check(cookies.owner, id)).json();
    expect((await detach(cookies.judge, id, dto.documents[0].link_id)).status).toBe(403);
    expect(await count(env().db, "evidence_links", env().businessId)).toBe(1);
  });
});

describe("the send guard", () => {
  it("a Missing payment is refused (412) without an acknowledgement: nothing is sent, the reasons come back", async () => {
    const { db, businessId } = env();
    const id = await newPayment();
    const res = await send(cookies.owner, id);
    expect(res.status).toBe(412);
    const body = ApiErrorSchema.parse(await res.json());
    expect(body.error.details).toMatchObject({
      reason: "evidence_ack_required",
      check: { flag: "missing" },
    });
    expect(await count(db, "execution_attempts", businessId)).toBe(0);
    expect(await jobs(db, "transfer.create")).toBe(0);
    expect(
      (await listAudit(repoCtx(db, businessId))).filter(
        (a) => a.action === "evidence_override" && a.subject === `payment:${id}`,
      ),
    ).toEqual([]);
  });

  it("with the acknowledgement it is sent, and the audit log holds the reasons shown", async () => {
    const { db, businessId } = env();
    const id = await newPayment();
    const shown = await (await check(cookies.owner, id)).json();
    const res = await send(cookies.owner, id, {
      evidence_ack: { acknowledged: true, check_hash: shown.check_hash },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      already_sent: false,
      evidence: { flag: "missing", overridden: true },
    });
    expect(await count(db, "execution_attempts", businessId)).toBe(1);
    expect(await jobs(db, "transfer.create")).toBe(1);
    const entries = (await listAudit(repoCtx(db, businessId))).filter(
      (a) => a.action === "evidence_override" && a.subject === `payment:${id}`,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorType: "user", subject: `payment:${id}` });
    const data = entries[0]?.data as {
      flag: string;
      reasons: { key: string; text: string }[];
      check_hash: string;
      bound_to_check: boolean;
    };
    expect(data.flag).toBe("missing");
    expect(data.reasons).toEqual(shown.reasons);
    expect(data.reasons[0]?.text).toBe(t.evidence.reason.noInvoice);
    expect(data).toMatchObject({ check_hash: shown.check_hash, bound_to_check: true });
  });

  it("an acknowledgement for a check that has since changed is refused (409) and sends nothing", async () => {
    const { db, businessId } = env();
    const id = await newPayment();
    const shown = await (await check(cookies.owner, id)).json();
    const inv = await addDocument(businessId, "invoice", [total("1"), supplier("Someone Else")]);
    await attach(cookies.owner, id, inv);
    const res = await send(cookies.owner, id, {
      evidence_ack: { acknowledged: true, check_hash: shown.check_hash },
    });
    expect(res.status).toBe(409);
    expect(ApiErrorSchema.parse(await res.json()).error.details).toMatchObject({
      reason: "evidence_changed",
    });
    expect(await count(db, "execution_attempts", businessId)).toBe(0);
  });

  it("a Strong payment is sent without an acknowledgement and without an override entry; a second send changes nothing", async () => {
    const { db, businessId } = env();
    const id = await newPayment();
    await attach(
      cookies.owner,
      id,
      await addDocument(businessId, "invoice", [total("80000"), supplier("Harbor Print Co.")]),
    );
    const res = await send(cookies.owner, id);
    expect(res.status).toBe(200);
    expect((await res.json()).evidence).toMatchObject({ flag: "strong", overridden: false });
    const again = await send(cookies.owner, id);
    expect((await again.json()).already_sent).toBe(true);
    expect(await count(db, "execution_attempts", businessId)).toBe(1);
    expect(await jobs(db, "transfer.create")).toBe(1);
    expect(
      (await listAudit(repoCtx(db, businessId))).filter(
        (a) => a.action === "evidence_override" && a.subject === `payment:${id}`,
      ),
    ).toEqual([]);
  });

  it("the viewer cannot send (403)", async () => {
    const id = await newPayment();
    expect((await send(cookies.judge, id, { evidence_ack: { acknowledged: true } })).status).toBe(
      403,
    );
    expect(await count(env().db, "execution_attempts", env().businessId)).toBe(0);
  });

  it("create-and-send runs the same guard: refused without an acknowledgement, nothing written", async () => {
    const { db, businessId } = env();
    const res = await call(
      routes.create,
      "POST",
      "/api/v1/payments",
      cookies.owner,
      {},
      { amount: { amount: "25.00", currency: "USD" }, reference: "no docs" },
    ).catch((e) => e);
    // The idempotency key is required: the request without one is a 400 before the guard.
    expect(res.status).toBe(400);
    const keyed = await routes.create(
      new Request(`${ORIGIN}/api/v1/payments`, {
        method: "POST",
        headers: {
          cookie: cookies.owner,
          origin: ORIGIN,
          "content-type": "application/json",
          "idempotency-key": "key-guard-0001",
        },
        body: JSON.stringify({
          amount: { amount: "25.00", currency: "USD" },
          reference: "no docs",
        }),
      }),
    );
    expect(keyed.status).toBe(412);
    expect(await count(db, "payments", businessId)).toBe(0);
    expect(await count(db, "execution_attempts", businessId)).toBe(0);
  });

  it("send: false saves a draft with no attempt and no job; the send route then sends it", async () => {
    const { db, businessId } = env();
    const draft = await routes.create(
      new Request(`${ORIGIN}/api/v1/payments`, {
        method: "POST",
        headers: {
          cookie: cookies.owner,
          origin: ORIGIN,
          "content-type": "application/json",
          "idempotency-key": "key-draft-0001",
        },
        body: JSON.stringify({
          amount: { amount: "25.00", currency: "USD" },
          reference: "draft",
          send: false,
        }),
      }),
    );
    expect(draft.status).toBe(201);
    const { payment } = await draft.json();
    expect(payment).toMatchObject({ attempt: null, transfer_status: null });
    expect(await count(db, "execution_attempts", businessId)).toBe(0);
    expect(await jobs(db, "transfer.create")).toBe(0);
    const sent = await send(cookies.owner, payment.id, { evidence_ack: { acknowledged: true } });
    expect(sent.status).toBe(200);
    expect((await sent.json()).payment.attempt).toMatchObject({ status: "INTENT" });
    expect(await jobs(db, "transfer.create")).toBe(1);
  });
});

describe("cross-tenant", () => {
  it("another business's payment evidence is 404 with no data, on every route", async () => {
    const own = await newPayment();
    const doc = await addDocument(env().businessId, "invoice", [total("80000")]);
    for (const res of [
      await check(cookies.otherOwner, own),
      await attach(cookies.otherOwner, own, doc),
      await send(cookies.otherOwner, own, { evidence_ack: { acknowledged: true } }),
      await detach(cookies.otherOwner, own, "00000000-0000-4000-8000-000000000001"),
    ]) {
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toContain("Harbor");
    }
    expect(await count(env().db, "evidence_links", env().businessId)).toBe(0);
    expect(await count(env().db, "execution_attempts", env().businessId)).toBe(0);
  });

  it("the foreign payment is 404 for the owner too, and a foreign document cannot be attached", async () => {
    expect((await check(cookies.owner, foreignPayment)).status).toBe(404);
    expect(
      (await send(cookies.owner, foreignPayment, { evidence_ack: { acknowledged: true } })).status,
    ).toBe(404);
    const own = await newPayment();
    expect((await attach(cookies.owner, own, foreignDocument)).status).toBe(404);
    expect(await count(env().db, "evidence_links", env().businessId)).toBe(0);
  });

  it("a link of another business's payment is not removable by this business's owner", async () => {
    const id = await newPayment();
    await attach(
      cookies.owner,
      id,
      await addDocument(env().businessId, "invoice", [total("80000")]),
    );
    const linkId = (await (await check(cookies.owner, id)).json()).documents[0].link_id;
    expect((await detach(cookies.otherOwner, id, linkId)).status).toBe(404);
    expect(await count(env().db, "evidence_links", env().businessId)).toBe(1);
  });
});
