// ADR 0021: the production plan-inputs loader and the re-run triggers, over recorded Airwallex answers
// (fixtures/airwallex: balances before the transfer and while its RFI was open, `fx-current-rate`, the
// real RFI follow-up sequence). The worker runs the registry `startWorker` builds in production, the
// loader reads the balances and rates through the real adapter, and no call leaves the machine.
import {
  confirmCriticality,
  createBusiness,
  createCounterparty,
  createObligation,
  createPayment,
  createPolicyVersion,
  createUser,
  enqueuePlanRerun,
  getLatestPlan,
  listPlanRevisions,
  repoCtx,
  withTransaction,
} from "@carnet/db";
import { type BusinessId, money, type PaymentId, parseMajor } from "@carnet/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "../../src/app/api/webhooks/airwallex/route";
import { closeAppDb } from "../../src/server/db";
import { memoryLogger } from "../../src/server/log";
import { RFI_DRAFT_JOB_KIND } from "../../src/worker/handlers/draft";
import { createWorker } from "../../src/worker/loop";
import { createPlanInputsLoader } from "../../src/worker/plan-inputs";
import { defaultRegistry } from "../../src/worker/run";
import { followUpSequence, type RfiWire, retarget, rfiEventBody, uid } from "../rfi-support";
import {
  blockedCalls,
  FetchStub,
  loadFixture,
  makeClient,
  paymentRow,
  query,
  signedHeaders,
  TEST_WEBHOOK_SECRET,
  webhookRequest,
  webTestDatabase,
} from "../support";

const db = webTestDatabase();

beforeAll(() => {
  process.env.DATABASE_URL = db().appUrl;
  process.env.AIRWALLEX_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
});
afterAll(async () => {
  await closeAppDb();
  expect(blockedCalls).toEqual([]);
});

const body = (name: string) => loadFixture(name).response.body;
const recordedUsd = (name: string): bigint => {
  const row = (body(name) as { currency: string; available_amount: number }[]).find(
    (b) => b.currency === "USD",
  );
  return parseMajor(String(row?.available_amount), "USD").minor;
};
const planCount = async (rc: ReturnType<typeof repoCtx>) => (await listPlanRevisions(rc)).length;
let balances: unknown = body("rfi-check8-balances-before-transfer");
const rfis = new Map<string, RfiWire>();

function harness() {
  const stub = new FetchStub();
  stub.on("GET", "/api/v1/balances/current", () => Response.json(balances));
  // One recorded answer for every pair asked (the fixture is EUR bought with USD).
  stub.on("GET", "/api/v1/fx/rates/current", () => Response.json(body("fx-current-rate")));
  stub.on("GET", /^\/api\/v1\/rfis\/[^/]+$/, (call) => {
    const found = rfis.get(call.path.split("/").pop() ?? "");
    return found
      ? Response.json(found)
      : Response.json({ code: "resource_not_found", message: "not found" }, { status: 404 });
  });
  const client = makeClient(stub);
  const loader = createPlanInputsLoader({ db: db().app.db, gateway: client });
  const registry = defaultRegistry(loader);
  registry.delete(RFI_DRAFT_JOB_KIND); // drafting has its own tests
  const worker = createWorker({
    db: db().app.db,
    registry,
    airwallex: client,
    logger: memoryLogger(),
    reconcileEveryMs: null,
  });
  const drain = async () => {
    while (await worker.tick()) {
      /* run every due job */
    }
  };
  return { stub, loader, drain };
}

async function seedBusiness() {
  const businessId = await createBusiness(db().app.db, { name: "Plan Inputs Co" });
  const rc = repoCtx(db().app.db, businessId);
  const counterparty = await createCounterparty(rc, {
    name: "Fennel Packaging GmbH",
    country: "DE",
  });
  const user = await createUser(rc, {
    email: `owner-${crypto.randomUUID()}@plan.example`,
    name: "Owner",
    role: "owner",
  });
  await withTransaction(db().app.db, async (tx) => {
    await createPolicyVersion(repoCtx(tx, businessId), {
      reserveFloor: [],
      perActionLimit: [{ currency: "USD", minor: "1000000" }],
      dailyCap: [{ currency: "USD", minor: "5000000" }],
      slippageBps: 50,
      quoteFreshnessSeconds: 60,
    });
  });
  const obligation = await createObligation(rc, {
    counterpartyId: counterparty.id,
    amountMinor: 100_000n,
    currency: "USD",
    dueAt: new Date("2026-11-20T00:00:00Z"),
  });
  await confirmCriticality(rc, {
    obligationId: obligation.id,
    criticality: 1,
    userId: user.id,
    at: new Date(),
  });
  const payment = await createPayment(rc, {
    obligationId: obligation.id,
    amount: money(100_000n, "USD"),
    sourceCurrency: "USD",
    method: "LOCAL",
    reference: "supplier invoice",
  });
  return { businessId, rc, obligation, payment, counterparty };
}

async function setTransfer(paymentId: PaymentId, transferId: string, status: string) {
  await query(
    db().appUrl,
    "UPDATE payments SET transfer_id = $1, transfer_status = $2, transfer_updated_at = $3 WHERE id = $4",
    [transferId, status, new Date("2026-11-03T09:57:00Z"), paymentId],
  );
}

const rerun = (businessId: BusinessId, eventId: string) =>
  enqueuePlanRerun(db().app.db, { businessId, eventId, cause: "test" });

const kinds = async (rc: ReturnType<typeof repoCtx>) =>
  (await getLatestPlan(rc))?.plan.actions.map((a) => a.kind);

describe("the production loader on recorded answers", () => {
  it("builds the inputs from obligations, policy, live balances and the indicative rate", async () => {
    const { businessId, obligation } = await seedBusiness();
    balances = body("rfi-check8-balances-before-transfer");
    const h = harness();
    const prefetched = await h.loader.prefetch?.(businessId, new Date("2026-11-03T10:00:00Z"));
    const inputs = await h.loader(
      db().app.db,
      businessId,
      new Date("2026-11-03T10:00:00Z"),
      prefetched,
    );
    expect(inputs.obligations).toEqual([
      expect.objectContaining({
        id: obligation.id,
        payee: "Fennel Packaging GmbH",
        criticality: 1,
        paymentId: expect.any(String),
        payoutMethod: "LOCAL",
      }),
    ]);
    const usd = inputs.balances.find((b) => b.currency === "USD");
    expect(usd?.availableMinor).toBe(recordedUsd("rfi-check8-balances-before-transfer"));
    expect(inputs.fxRates.length).toBeGreaterThan(0);
    expect(inputs.fxRates.every((r) => r.rate === "0.8847" && r.buy === "USD")).toBe(true);
    expect(inputs.policy.version).toBe(1);
    expect(inputs.held).toEqual([]);
    // Balances were read through the gateway, with the adapter's own timeout and no x-api-version on FX.
    expect(h.stub.count("GET", "/api/v1/balances/current")).toBe(1);
    const fxCall = h.stub.calls.find((c) => c.path === "/api/v1/fx/rates/current");
    expect(fxCall?.headers["x-api-version"]).toBeUndefined();
  });

  it("leaves out an obligation whose transfer is on its way and keeps a failed one", async () => {
    const { businessId, payment } = await seedBusiness();
    const h = harness();
    const now = new Date("2026-11-03T10:00:00Z");
    const ids = async () => {
      const pre = await h.loader.prefetch?.(businessId, now);
      return (await h.loader(db().app.db, businessId, now, pre)).obligations.length;
    };
    expect(await ids()).toBe(1); // not sent yet
    for (const [status, left] of [
      ["SENT", 0],
      ["PROCESSING", 0],
      ["PAID", 0],
      ["CANCELLED", 1], // a failed transfer ends CANCELLED: still owed
      ["FAILED", 1],
    ] as const) {
      await setTransfer(payment.id, uid("99999999"), status);
      expect(await ids(), status).toBe(left);
    }
  });
});

describe("a held payment re-plans without an RFI-derived money status", () => {
  it("writes revisions only when the inputs change, and none for a replayed or unchanged event", async () => {
    const { businessId, rc, obligation, payment } = await seedBusiness();
    const transferId = uid("77777777");
    balances = body("rfi-check8-balances-before-transfer");
    const h = harness();

    // Revision 1: the obligation is due and funded from the balance.
    await rerun(businessId, "evt-1");
    await h.drain();
    expect(await planCount(rc)).toBe(1);
    expect(await kinds(rc)).toEqual(["fund"]);

    // The payment is sent: the balance is debited at creation, so the obligation is out of the plan.
    await setTransfer(payment.id, transferId, "SENT");
    balances = body("rfi-check8-balances-after-create");
    await rerun(businessId, "evt-2");
    await h.drain();
    expect(await planCount(rc)).toBe(2);
    expect(await kinds(rc)).toEqual([]);

    // The RFI arrives by webhook (the real route), is fetched and ingested; the re-run follows.
    const rfiId = uid("88888888");
    const seq = followUpSequence();
    const snap = (i: number) =>
      retarget(seq[i] as RfiWire, { id: rfiId, accountId: "acct_not_mapped", transferId });
    const before = await paymentRow(db().app.db, { businessId, paymentId: payment.id });
    balances = body("rfi-check8-balances-rfi-open");
    rfis.set(rfiId, snap(0));
    const hook = rfiEventBody(rfiId);
    expect((await POST(webhookRequest(hook, signedHeaders(hook)))).status).toBe(200);
    await h.drain();

    const revisions = await listPlanRevisions(rc);
    expect(revisions.map((r) => r.plan.revision)).toEqual([3, 2, 1]);
    const held = revisions[0];
    expect(new Set(revisions.map((r) => r.plan.inputs_hash)).size).toBe(3);
    expect(held?.plan.actions.map((a) => a.kind)).toEqual(["payout"]);
    expect(held?.plan.actions[0]?.reason_code).toBe("PAYOUT_ALTERNATE_FOR_HELD");
    expect(held?.plan.actions[0]?.params).toMatchObject({
      obligation_id: obligation.id,
      held_payment_id: payment.id,
    });
    const heldInputs = held?.inputs as { held: { paymentId: string }[] };
    expect(heldInputs.held.map((x) => x.paymentId)).toEqual([payment.id]);

    // The RFI changed no money status (ADR 0006): the payment is exactly as it was.
    expect(await paymentRow(db().app.db, { businessId, paymentId: payment.id })).toEqual(before);
    expect(h.stub.count("GET", /^\/api\/v1\/transfers/)).toBe(0);

    // Replays and unchanged inputs write nothing, whatever asks.
    await rerun(businessId, "evt-2");
    await rerun(businessId, "evt-3");
    await h.drain();
    expect(await planCount(rc)).toBe(3);
    rfis.set(rfiId, snap(0));
    const sameHook = rfiEventBody(rfiId);
    expect((await POST(webhookRequest(sameHook, signedHeaders(sameHook)))).status).toBe(200);
    await h.drain();
    expect(await planCount(rc)).toBe(3);

    // The RFI is answered: it no longer holds, the transfer is still SENT, and the plan follows.
    rfis.set(rfiId, snap(1));
    const answered = rfiEventBody(rfiId, "rfi.answered");
    expect((await POST(webhookRequest(answered, signedHeaders(answered)))).status).toBe(200);
    await h.drain();
    const after = await listPlanRevisions(rc);
    expect(after.map((r) => r.plan.revision)).toEqual([4, 3, 2, 1]);
    expect(after[0]?.inputs).toMatchObject({ held: [] });
    expect(await kinds(rc)).toEqual([]);
    const settled = await paymentRow(db().app.db, { businessId, paymentId: payment.id });
    expect(settled.transferStatus).toBe("SENT");
    expect(settled).toEqual(before);
  });
});

describe("triggers share the changing transaction", () => {
  it("a policy version queues exactly one re-run, and a rolled-back change leaves none", async () => {
    const businessId = await createBusiness(db().app.db, { name: "Atomic Co" });
    const count = async () =>
      (
        await query<{ n: string }>(
          db().appUrl,
          "SELECT count(*)::text AS n FROM outbox_jobs WHERE kind = 'plan.rerun' AND payload->>'businessId' = $1",
          [businessId],
        )
      )[0]?.n;
    const content = {
      reserveFloor: [],
      perActionLimit: [],
      dailyCap: [],
      slippageBps: 50,
      quoteFreshnessSeconds: 60,
    };
    await withTransaction(db().app.db, (tx) =>
      createPolicyVersion(repoCtx(tx, businessId), content),
    );
    expect(await count()).toBe("1");

    await expect(
      withTransaction(db().app.db, async (tx) => {
        await createPolicyVersion(repoCtx(tx, businessId), content);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await count()).toBe("1");
    const versions = await query<{ n: string }>(
      db().appUrl,
      "SELECT count(*)::text AS n FROM policies WHERE business_id = $1",
      [businessId],
    );
    expect(versions[0]?.n).toBe("1");
  });
});
