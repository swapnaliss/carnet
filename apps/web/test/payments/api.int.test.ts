// Payments API (M1-08 AC 1, 6, 7 and the cross-tenant cases of M1-10): the real route handlers built
// on a test runtime (sessions, guards, tenant repositories, idempotency) with a stubbed balance read.
// The worker half of an idempotent create is run too, against recorded Airwallex responses, to prove
// that one key yields one payment AND one transfer.
import type { Balance } from "@carnet/airwallex";
import {
  createBusiness,
  createCounterparty,
  createPayment,
  type Db,
  enqueueJob,
  insertWebhookEvent,
  repoCtx,
  updatePaymentTransfer,
} from "@carnet/db";
import {
  ApiErrorSchema,
  type BusinessId,
  type Currency,
  money,
  type PaymentId,
} from "@carnet/domain";
import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRouteKit, type RouteHandler } from "../../src/lib/define-route";
import { memoryLogger } from "../../src/server/log";
import {
  createPaymentRoutes,
  type PaymentDetailResponse,
  type PaymentListResponse,
} from "../../src/server/payments";
import { executeTransferAttempt } from "../../src/worker/handlers/create-transfer";
import { addUser, ORIGIN, sessionCookie, setupAuthTestEnv } from "../auth/setup";
import { FetchStub, loadFixture, makeClient } from "../support";

const env = setupAuthTestEnv();
const cookies = { owner: "", approver: "", judge: "", otherOwner: "" };
let routes: ReturnType<typeof createPaymentRoutes>;
let balances: () => Promise<Balance[]>;
let otherBusiness: BusinessId;
let foreignPayment: PaymentId;

const usd = (minor: bigint): Balance => {
  const m = money(minor, "USD");
  return { currency: "USD", available: m, pending: m, reserved: m, total: m };
};

type Table = "payments" | "execution_attempts" | "idempotency_keys";

async function count(db: Db, table: Table, businessId: BusinessId): Promise<number> {
  const rows = await db.execute<{ n: string }>(
    sql`SELECT count(*)::text AS n FROM ${sql.identifier(table)} WHERE business_id = ${businessId}`,
  );
  return Number(rows.rows[0]?.n ?? 0);
}

async function jobs(db: Db, kind: string): Promise<Array<{ payload: Record<string, string> }>> {
  const rows = await db.execute<{ payload: Record<string, string> }>(
    sql`SELECT payload FROM outbox_jobs WHERE kind = ${kind} ORDER BY created_at`,
  );
  return rows.rows;
}

beforeAll(async () => {
  const { db, passwords, businessId } = env();
  await createCounterparty(repoCtx(db, businessId), {
    name: "Supplier (synthetic)",
    country: "US",
  });
  const kit = createRouteKit({
    authz: env().authz,
    db: () => db,
    logger: () => env().rt.logger,
    now: () => new Date(),
  });
  routes = createPaymentRoutes(kit, { balances: () => balances() });

  otherBusiness = await createBusiness(db, { name: "Business B (synthetic)" });
  foreignPayment = (
    await createPayment(repoCtx(db, otherBusiness), {
      amount: money(1000n, "USD"),
      sourceCurrency: "USD",
      method: "LOCAL",
      reference: "foreign-secret-reference",
    })
  ).id;
  await addUser(db, otherBusiness, {
    email: "owner@b.example",
    role: "owner",
    password: "b-owner-password",
  });
  cookies.owner = await sessionCookie(env(), "owner@carnet.example", passwords.owner);
  cookies.approver = await sessionCookie(env(), "approver@carnet.example", passwords.approver);
  cookies.judge = await sessionCookie(env(), "judge@carnet.example", passwords.judge);
  cookies.otherOwner = await sessionCookie(env(), "owner@b.example", "b-owner-password");
});

beforeEach(async () => {
  balances = async () => [usd(10_000_000_00n)];
  const { db, businessId } = env();
  for (const t of ["idempotency_keys", "execution_attempts", "payments"] as const) {
    await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE business_id = ${businessId}`);
  }
  await db.execute(sql`DELETE FROM outbox_jobs`);
  await db.execute(sql`DELETE FROM webhook_events`);
});

function post(
  route: RouteHandler,
  path: string,
  cookie: string,
  body: unknown,
  headers: Record<string, string> = {},
  params?: Record<string, string>,
) {
  return route(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    params ? { params: Promise.resolve(params) } : undefined,
  );
}

function get(route: RouteHandler, path: string, cookie: string, params?: Record<string, string>) {
  return route(
    new Request(`${ORIGIN}${path}`, { method: "GET", headers: { cookie, origin: ORIGIN } }),
    params ? { params: Promise.resolve(params) } : undefined,
  );
}

const body = (amount = "25.00", currency: Currency = "USD", reference = "Invoice 1180") => ({
  amount: { amount, currency },
  reference,
  // M2-03: a payment with no documents is Missing evidence; these tests are about the payment API, so
  // they acknowledge it (the evidence guard itself is tested in test/evidence/evidence-check.int.test.ts).
  evidence_ack: { acknowledged: true as const },
});

const create = (cookie: string, key: string | null, b: unknown = body()) =>
  post(routes.create, "/api/v1/payments", cookie, b, key ? { "idempotency-key": key } : {});

async function errorCode(res: Response): Promise<string> {
  return ApiErrorSchema.parse(await res.json()).error.code;
}

describe("POST /api/v1/payments (owner)", () => {
  it("201: the payment, its INTENT attempt and the transfer.create job are written together", async () => {
    const res = await create(cookies.owner, "key-create-0001");
    expect(res.status).toBe(201);
    const { payment } = (await res.json()) as { payment: PaymentDetailResponse["payment"] };
    expect(payment).toMatchObject({
      reference: "Invoice 1180",
      amount: { amount: "25.00", currency: "USD" },
      method: "LOCAL",
      transfer_id: null,
      view: null,
      attempt: { status: "INTENT", sent_at: null, sends: 0 },
    });
    const [job] = await jobs(env().db, "transfer.create");
    expect(job?.payload).toMatchObject({
      attemptId: payment.attempt?.id,
      paymentId: payment.id,
      businessId: env().businessId,
    });
  });

  it("AC7: the same Idempotency-Key twice yields one payment and one transfer", async () => {
    const first = await create(cookies.owner, "key-idem-0001");
    const second = await create(cookies.owner, "key-idem-0001");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    const a = (await first.json()) as { payment: { id: string } };
    const b = (await second.json()) as { payment: { id: string } };
    expect(b.payment.id).toBe(a.payment.id);
    expect(await count(env().db, "payments", env().businessId)).toBe(1);
    expect(await count(env().db, "execution_attempts", env().businessId)).toBe(1);
    const queued = await jobs(env().db, "transfer.create");
    expect(queued).toHaveLength(1);

    // The worker half: every queued job runs (twice, as a retry would), one create call is made.
    const stub = new FetchStub();
    stub.fixture("beneficiary-create-us-usd-local");
    stub.on("POST", "/api/v1/transfers/create", (call) =>
      Response.json(
        {
          ...(loadFixture("transfer-create-local-usd").response.body as object),
          request_id: (call.json as { request_id: string }).request_id,
        },
        { status: 201 },
      ),
    );
    const client = makeClient(stub);
    const ctx = {
      db: env().db,
      airwallex: client,
      airwallexWriter: client,
      logger: memoryLogger(),
    };
    for (const job of [...queued, ...queued]) {
      await executeTransferAttempt(
        ctx,
        job.payload.businessId as BusinessId,
        job.payload.attemptId as never,
      );
    }
    expect(stub.count("POST", "/api/v1/transfers/create")).toBe(1);
  });

  it("concurrent creates with one key still write one payment", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => create(cookies.owner, "key-race-0001")),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const ids = new Set(
      await Promise.all(
        results.map(async (r) => ((await r.json()) as { payment: { id: string } }).payment.id),
      ),
    );
    expect(ids.size).toBe(1);
    expect(await count(env().db, "payments", env().businessId)).toBe(1);
  });

  it("the same key with another body is IDEMPOTENCY_KEY_REUSED (422) and writes nothing", async () => {
    await create(cookies.owner, "key-reuse-0001", body("25.00"));
    const res = await create(cookies.owner, "key-reuse-0001", body("26.00"));
    expect(res.status).toBe(422);
    expect(await errorCode(res)).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await count(env().db, "payments", env().businessId)).toBe(1);
  });

  it("400 without an Idempotency-Key; 400 on bad money; nothing written", async () => {
    expect((await create(cookies.owner, null)).status).toBe(400);
    expect((await create(cookies.owner, "key-bad-0001", body("25.001"))).status).toBe(400);
    expect((await create(cookies.owner, "key-bad-0002", { ...body(), extra: 1 })).status).toBe(400);
    expect(await count(env().db, "payments", env().businessId)).toBe(0);
  });

  it("412 when the sandbox wallet cannot cover the amount (clear message), nothing written", async () => {
    balances = async () => [usd(1000n)];
    const res = await create(cookies.owner, "key-funds-0001", body("25.00"));
    expect(res.status).toBe(412);
    const err = ApiErrorSchema.parse(await res.json()).error;
    expect(err.code).toBe("PRECONDITION_FAILED");
    expect(err.message).toContain(
      "Not enough USD in the sandbox wallet: 10.00 available, 25.00 needed",
    );
    expect(err.details).toMatchObject({ reason: "insufficient_funds" });
    expect(await count(env().db, "payments", env().businessId)).toBe(0);
  });

  it("502 when the balance check fails, nothing written", async () => {
    balances = () => Promise.reject(new Error("timeout"));
    const res = await create(cookies.owner, "key-upstream-0001");
    expect(res.status).toBe(502);
    expect(await errorCode(res)).toBe("UPSTREAM_ERROR");
    expect(await count(env().db, "payments", env().businessId)).toBe(0);
  });
});

describe("AC6: roles", () => {
  it("the viewer (judge) cannot create (403) but sees the list; the approver cannot create", async () => {
    await create(cookies.owner, "key-roles-0001");
    const judge = await create(cookies.judge, "key-roles-0002");
    expect(judge.status).toBe(403);
    expect(await errorCode(judge)).toBe("FORBIDDEN");
    expect((await create(cookies.approver, "key-roles-0003")).status).toBe(403);
    expect(await count(env().db, "payments", env().businessId)).toBe(1);

    const list = await get(routes.list, "/api/v1/payments", cookies.judge);
    expect(list.status).toBe(200);
    const page = (await list.json()) as PaymentListResponse;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.attempt?.status).toBe("INTENT");
    expect(Number.isNaN(Date.parse(page.server_time))).toBe(false);
  });

  it("no session: 401 on both", async () => {
    expect((await get(routes.list, "/api/v1/payments", "")).status).toBe(401);
    expect((await create("", "key-anon-0001")).status).toBe(401);
  });
});

describe("cross-tenant: GET /api/v1/payments/{id} and POST …/{id}/simulate", () => {
  it("another business's id is 404 with no data; the list never shows it", async () => {
    const res = await get(routes.detail, `/api/v1/payments/${foreignPayment}`, cookies.owner, {
      id: foreignPayment,
    });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("foreign-secret-reference");
    const sim = await post(
      routes.simulate,
      `/api/v1/payments/${foreignPayment}/simulate`,
      cookies.owner,
      { next_status: "SENT" },
      {},
      { id: foreignPayment },
    );
    expect(sim.status).toBe(404);
    expect(await jobs(env().db, "transfer.simulate")).toHaveLength(0);
    const page = (await (
      await get(routes.list, "/api/v1/payments", cookies.owner)
    ).json()) as PaymentListResponse;
    expect(page.items.map((p) => p.id)).not.toContain(foreignPayment);
    // and the other way round
    const own = (await (await create(cookies.owner, "key-xt-0001")).json()) as {
      payment: { id: string };
    };
    const theirs = await get(
      routes.detail,
      `/api/v1/payments/${own.payment.id}`,
      cookies.otherOwner,
      {
        id: own.payment.id,
      },
    );
    expect(theirs.status).toBe(404);
  });

  it("simulate: viewer 403; 409 before a transfer exists; 202 + one job once it does", async () => {
    const own = (await (await create(cookies.owner, "key-sim-0001")).json()) as {
      payment: { id: PaymentId };
    };
    const id = own.payment.id;
    const call = (cookie: string, b: unknown = { next_status: "SENT" }) =>
      post(routes.simulate, `/api/v1/payments/${id}/simulate`, cookie, b, {}, { id });
    expect((await call(cookies.judge)).status).toBe(403);
    expect((await call(cookies.owner)).status).toBe(409);
    await updatePaymentTransfer(repoCtx(env().db, env().businessId), id, {
      transferId: "420468b9-15f0-4e07-a015-155c99b92444",
      transferStatus: "PROCESSING",
      transferUpdatedAt: new Date(),
    });
    expect((await call(cookies.owner, { next_status: "FAILED" })).status).toBe(400);
    const ok = await call(cookies.owner);
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ queued: true, next_status: "SENT" });
    const queued = await jobs(env().db, "transfer.simulate");
    expect(queued.map((j) => j.payload)).toEqual([
      { paymentId: id, businessId: env().businessId, nextStatus: "SENT" },
    ]);
  });
});

describe("GET /api/v1/payments/{id}: projection and webhook evidence", () => {
  it("shows the projected view and the webhooks that named its transfer (raw body for the owner only)", async () => {
    const own = (await (await create(cookies.owner, "key-detail-0001")).json()) as {
      payment: { id: PaymentId };
    };
    const id = own.payment.id;
    const transferId = "420468b9-15f0-4e07-a015-155c99b92444";
    await updatePaymentTransfer(repoCtx(env().db, env().businessId), id, {
      transferId,
      transferStatus: "SENT",
      transferUpdatedAt: new Date("2026-11-06T01:00:00Z"),
    });
    const raw = JSON.stringify({
      id: "evt-1",
      name: "payout.transfer.sent",
      data: { id: transferId },
    });
    const event = await insertWebhookEvent(env().db, {
      providerEventId: "evt-1",
      name: "payout.transfer.sent",
      rawBody: raw,
      signatureOk: true,
    });
    await enqueueJob(env().db, {
      kind: "transfer.sync",
      payload: { transferId, webhookEventId: event.id, providerEventId: "evt-1" },
    });
    // A delivery for some other transfer is not listed.
    const other = await insertWebhookEvent(env().db, {
      providerEventId: "evt-2",
      name: "payout.transfer.sent",
      rawBody: "{}",
      signatureOk: true,
    });
    await enqueueJob(env().db, {
      kind: "transfer.sync",
      payload: { transferId: "someone-else", webhookEventId: other.id },
    });

    const owner = (await (
      await get(routes.detail, `/api/v1/payments/${id}`, cookies.owner, { id })
    ).json()) as PaymentDetailResponse;
    expect(owner.payment).toMatchObject({
      transfer_id: transferId,
      transfer_status: "SENT",
      view: "SENT",
      held: false,
      final: false,
    });
    expect(owner.webhooks).toHaveLength(1);
    expect(owner.webhooks[0]).toMatchObject({
      event_id: "evt-1",
      name: "payout.transfer.sent",
      signature_ok: true,
      raw_body: raw,
    });
    const judge = (await (
      await get(routes.detail, `/api/v1/payments/${id}`, cookies.judge, { id })
    ).json()) as PaymentDetailResponse;
    expect(judge.webhooks).toHaveLength(1);
    expect(judge.webhooks[0]).not.toHaveProperty("raw_body");
  });
});
