// `transfer.create` (M1-08 AC 2, 3): the attempt exists before the outbound call and ends CONFIRMED;
// a timeout leaves it UNKNOWN and the reconcile pass resolves it by the same request_id with zero
// additional create calls. Airwallex answers from recorded M0-03 responses (re-keyed to the attempt's
// request_id); nothing reaches the network.
import {
  createAttempt,
  createCounterparty,
  getAttempt,
  getCounterparty,
  repoCtx,
} from "@carnet/db";
import { newRequestId, type RequestId } from "@carnet/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryLogger } from "../../src/server/log";
import { attemptRecord, executeTransferAttempt } from "../../src/worker/handlers/create-transfer";
import { handleTransferSimulate } from "../../src/worker/handlers/simulate-transfer";
import { runReconcile } from "../../src/worker/reconcile";
import {
  blockedCalls,
  FetchStub,
  loadFixture,
  makeClient,
  paymentRow,
  query,
  seedPayment,
  transferRoute,
  webTestDatabase,
} from "../support";

const db = webTestDatabase();

beforeEach(async () => {
  await query(db().appUrl, "DELETE FROM execution_attempts");
  await query(db().appUrl, "DELETE FROM payments");
  await query(db().appUrl, "DELETE FROM counterparties");
});

type Wire = Record<string, unknown> & { id: string; request_id: string; status: string };
const created = () => loadFixture("transfer-create-local-usd").response.body as Wire;

/** A payment with a counterparty (no beneficiary yet) and its INTENT attempt, as the API writes it. */
async function seedIntent() {
  const { businessId, paymentId } = await seedPayment(db().app.db, db().appUrl);
  const rc = repoCtx(db().app.db, businessId);
  const counterparty = await createCounterparty(rc, {
    name: "Supplier (synthetic)",
    country: "US",
  });
  await query(db().appUrl, "UPDATE payments SET counterparty_id = $1 WHERE id = $2", [
    counterparty.id,
    paymentId,
  ]);
  const attempt = await createAttempt(rc, {
    kind: "transfer",
    refId: paymentId,
    requestId: newRequestId(),
  });
  return { businessId, paymentId, attempt, counterparty, rc };
}

function setup(opts: { createTimesOut?: boolean } = {}) {
  const stub = new FetchStub();
  stub.fixture("beneficiary-create-us-usd-local");
  stub.fixture("rfi-check1-list");
  const transfers = new Map<string, Wire>();
  transferRoute(stub, (id) => transfers.get(id));
  // Airwallex's side: a create stores the transfer under the request_id it was sent with.
  stub.on("POST", "/api/v1/transfers/create", (call, init) => {
    const rid = (call.json as { request_id: string }).request_id;
    const wire = { ...created(), request_id: rid };
    transfers.set(wire.id, wire);
    if (opts.createTimesOut) {
      // Accepted by Airwallex, but the answer never reaches Carnet.
      return new Promise<Response>((_, reject) =>
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    }
    return Response.json(wire, { status: 201 });
  });
  let listVisible = !opts.createTimesOut;
  stub.on("GET", "/api/v1/transfers", (call) => {
    const rid = call.url.searchParams.get("request_id");
    const items = listVisible ? [...transfers.values()].filter((t) => t.request_id === rid) : [];
    return Response.json({ items, page_after: null });
  });
  const client = makeClient(stub, opts.createTimesOut ? { timeoutMs: 20, maxAttempts: 1 } : {});
  const logger = memoryLogger();
  const ctx = { db: db().app.db, airwallex: client, airwallexWriter: client, logger };
  const creates = () => stub.calls.filter((c) => c.path === "/api/v1/transfers/create");
  return { stub, ctx, creates, transfers, showInList: () => (listVisible = true) };
}

describe("AC2: the attempt exists before the call and ends CONFIRMED", () => {
  it("INTENT -> SENT_TO_AIRWALLEX (stamped) -> CONFIRMED; the payment is linked to the transfer", async () => {
    const seeded = await seedIntent();
    const s = setup();
    let statusAtCall: string | undefined;
    s.stub.on("POST", "/api/v1/transfers/create", async (call) => {
      // What the database holds at the moment the outbound request is made.
      statusAtCall = (await getAttempt(seeded.rc, seeded.attempt.id))?.status;
      const wire = { ...created(), request_id: (call.json as { request_id: string }).request_id };
      s.transfers.set(wire.id, wire);
      return Response.json(wire, { status: 201 });
    });

    const result = await executeTransferAttempt(s.ctx, seeded.businessId, seeded.attempt.id);

    expect(result.outcome).toBe("confirmed");
    expect(statusAtCall).toBe("SENT_TO_AIRWALLEX");
    const attempt = await getAttempt(seeded.rc, seeded.attempt.id);
    expect(attempt?.status).toBe("CONFIRMED");
    const rec = attemptRecord(attempt ?? { response: null });
    expect(rec.transferId).toBe(created().id);
    expect(rec.sends).toBe(1);
    // created_at (INTENT commit) <= sentAt (before the call) <= confirmedAt (after the answer)
    const createdAt = attempt?.createdAt.getTime() ?? Number.NaN;
    expect(Date.parse(rec.sentAt ?? "")).toBeGreaterThanOrEqual(createdAt);
    expect(Date.parse(rec.confirmedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(rec.sentAt ?? ""));
    // The request carried the persisted request_id and the payment's money in major units.
    const [call] = s.creates();
    expect(call?.json).toMatchObject({
      request_id: seeded.attempt.requestId,
      source_currency: "USD",
      transfer_currency: "USD",
      source_amount: 20,
      transfer_method: "LOCAL",
    });
    const payment = await paymentRow(db().app.db, seeded);
    expect(payment.transferId).toBe(created().id);
    expect(payment.transferStatus).toBe("SCHEDULED");
    // The beneficiary was created once through the adapter and stored on the counterparty.
    const cp = await getCounterparty(seeded.rc, seeded.counterparty.id);
    expect(cp?.beneficiaryId).toBe(
      (loadFixture("beneficiary-create-us-usd-local").response.body as { id: string }).id,
    );
    expect(blockedCalls).toEqual([]);
  });

  it("a re-run after CONFIRMED sends nothing", async () => {
    const seeded = await seedIntent();
    const s = setup();
    await executeTransferAttempt(s.ctx, seeded.businessId, seeded.attempt.id);
    const again = await executeTransferAttempt(s.ctx, seeded.businessId, seeded.attempt.id);
    expect(again).toEqual({ outcome: "skipped", status: "CONFIRMED" });
    expect(s.creates()).toHaveLength(1);
    expect(s.stub.count("POST", "/api/v1/beneficiaries/create")).toBe(1);
  });

  it("a 4xx from Airwallex ends REJECTED (nothing was created)", async () => {
    const seeded = await seedIntent();
    const s = setup();
    s.stub.on("POST", "/api/v1/transfers/create", () =>
      Response.json(loadFixture("error-bad-json-field").response.body, { status: 400 }),
    );
    const result = await executeTransferAttempt(s.ctx, seeded.businessId, seeded.attempt.id);
    expect(result.outcome).toBe("rejected");
    expect((await getAttempt(seeded.rc, seeded.attempt.id))?.status).toBe("REJECTED");
    expect((await paymentRow(db().app.db, seeded)).transferId).toBeNull();
  });
});

describe("transfer.simulate (owner action, sandbox only)", () => {
  it("calls only /simulation/*, applies the fetched result, and is a no-op once there", async () => {
    const recorded = created();
    const ref = await seedPayment(db().app.db, db().appUrl, {
      transferId: recorded.id,
      status: "PROCESSING",
      updatedAt: new Date("2026-11-03T09:43:22Z"),
    });
    const s = setup();
    let current: Wire = {
      ...recorded,
      status: "PROCESSING",
      updated_at: "2026-11-03T09:43:22+0000",
    };
    transferRoute(s.stub, () => current);
    // The sandbox answered 500 for a LOCAL SENT transition that it applied (transition-local-usd-sent).
    s.stub.on("POST", /^\/api\/v1\/simulation\/transfers\/[^/]+\/transition$/, (call) => {
      expect(call.json).toEqual({ next_status: "SENT" });
      current = { ...current, status: "SENT", updated_at: "2026-11-03T09:43:26+0000" };
      return Response.json(loadFixture("transition-local-usd-sent").response.body, { status: 500 });
    });
    const payload = { paymentId: ref.paymentId, businessId: ref.businessId, nextStatus: "SENT" };

    await handleTransferSimulate(payload, s.ctx, {} as never);
    expect((await paymentRow(db().app.db, ref)).transferStatus).toBe("SENT");
    await handleTransferSimulate(payload, s.ctx, {} as never);
    expect(s.stub.count("POST", /\/transition$/)).toBe(1);
    const posts = s.stub.calls.filter(
      (c) => c.method === "POST" && !c.path.includes("authentication"),
    );
    for (const p of posts) expect(p.path.startsWith("/api/v1/simulation/")).toBe(true);
  });
});

describe("AC3: a timeout leaves UNKNOWN; reconcile resolves it by the same request_id", () => {
  it("UNKNOWN after the timeout, CONFIRMED by lookup, zero additional create calls", async () => {
    const seeded = await seedIntent();
    const s = setup({ createTimesOut: true });

    const first = await executeTransferAttempt(s.ctx, seeded.businessId, seeded.attempt.id);

    expect(first.outcome).toBe("unknown");
    const unknown = await getAttempt(seeded.rc, seeded.attempt.id);
    expect(unknown?.status).toBe("UNKNOWN");
    expect(attemptRecord(unknown ?? { response: null }).error?.kind).toBe("AirwallexTimeout");
    const createsBefore = s.creates().length;
    expect(createsBefore).toBe(1);

    // The transfer exists at Airwallex (the create was accepted); the lookup can now see it.
    s.showInList();
    const summary = await runReconcile(s.ctx);

    expect(summary.attemptsConfirmed).toBe(1);
    expect(s.creates()).toHaveLength(createsBefore); // zero additional create calls
    const lookups = s.stub.calls.filter(
      (c) => c.method === "GET" && c.path === "/api/v1/transfers",
    );
    expect(lookups.length).toBeGreaterThan(0);
    for (const l of lookups) {
      expect(l.url.searchParams.get("request_id")).toBe(seeded.attempt.requestId);
    }
    const confirmed = await getAttempt(seeded.rc, seeded.attempt.id);
    expect(confirmed?.status).toBe("CONFIRMED");
    expect(confirmed?.requestId).toBe(seeded.attempt.requestId as RequestId);
    const rec = attemptRecord(confirmed ?? { response: null });
    expect(rec).toMatchObject({ transferId: created().id, resolvedBy: "reconcile_lookup" });
    expect(rec.sentAt).toBeTruthy(); // the sender's record survives the resolution
    const payment = await paymentRow(db().app.db, seeded);
    expect(payment.transferId).toBe(created().id);
    // A re-run of the job afterwards sends nothing either.
    await executeTransferAttempt(s.ctx, seeded.businessId, seeded.attempt.id);
    expect(s.creates()).toHaveLength(createsBefore);
  });

  it("stays UNKNOWN (no resend) while the lookup finds nothing", async () => {
    const seeded = await seedIntent();
    const s = setup({ createTimesOut: true });
    await executeTransferAttempt(s.ctx, seeded.businessId, seeded.attempt.id);
    const before = s.creates().length;
    await runReconcile(s.ctx);
    expect((await getAttempt(seeded.rc, seeded.attempt.id))?.status).toBe("UNKNOWN");
    expect(s.creates()).toHaveLength(before);
    await executeTransferAttempt(s.ctx, seeded.businessId, seeded.attempt.id);
    expect(s.creates()).toHaveLength(before);
  });
});
