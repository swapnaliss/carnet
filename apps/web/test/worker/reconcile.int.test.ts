// The reconcile job (AC 9): a missed webhook is recovered within one pass, and an UNKNOWN attempt is
// resolved by lookup with no create call. Airwallex answers from recorded responses.
import { createAttempt, getAttempt, listAudit, repoCtx, updateAttemptStatus } from "@carnet/db";
import { newRequestId, type RequestId } from "@carnet/domain";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryLogger } from "../../src/server/log";
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
});

type Wire = Record<string, unknown> & { id: string; request_id: string; status: string };

function setup() {
  const stub = new FetchStub();
  stub.fixture("rfi-check1-list"); // GET /rfis (open statuses)
  const transfers = new Map<string, Wire>();
  transferRoute(stub, (id) => transfers.get(id));
  // GET /transfers?request_id=… answers a page holding whatever transfers are known.
  stub.on("GET", "/api/v1/transfers", () =>
    Response.json({ items: [...transfers.values()], page_after: null }),
  );
  const logger = memoryLogger();
  const ctx = { db: db().app.db, airwallex: makeClient(stub), logger };
  const posts = () =>
    stub.calls.filter((c) => c.method === "POST" && !c.path.includes("authentication"));
  return { stub, transfers, logger, ctx, posts };
}

describe("AC9: reconcile", () => {
  it("brings a payment whose webhook was never delivered to the fetched status in one pass", async () => {
    // transfer-fetch-local-usd-paid (M0-03) reads SENT at 09:43:26; the payment still says SCHEDULED.
    const recorded = loadFixture("transfer-fetch-local-usd-paid").response.body as Wire;
    const ref = await seedPayment(db().app.db, db().appUrl, {
      transferId: recorded.id,
      status: "SCHEDULED",
      updatedAt: new Date("2026-11-03T09:43:20Z"),
    });
    const s = setup();
    s.transfers.set(recorded.id, recorded);

    const summary = await runReconcile(s.ctx);

    const row = await paymentRow(db().app.db, ref);
    expect(row.transferStatus).toBe("SENT");
    expect(row.transferUpdatedAt?.toISOString()).toBe("2026-11-03T09:43:26.000Z");
    expect(summary).toMatchObject({ transfers: 1, transfersApplied: 1, errors: 0 });
    expect(summary.rfis).toBeGreaterThan(0); // the open-RFI poll ran (recorded list)
    expect(s.stub.count("GET", "/api/v1/rfis")).toBe(1);
    expect(s.posts()).toEqual([]);
    expect(blockedCalls).toEqual([]);
  });

  it("does not poll settled transfers (FAILED, CANCELLED) but keeps polling PAID", async () => {
    const paid = await seedPayment(db().app.db, db().appUrl, {
      transferId: "22222222-2222-4222-8222-222222222222",
      status: "PAID",
      updatedAt: new Date("2026-11-03T09:00:00Z"),
    });
    await seedPayment(db().app.db, db().appUrl, {
      transferId: "33333333-3333-4333-8333-333333333333",
      status: "CANCELLED",
      updatedAt: new Date("2026-11-03T09:00:00Z"),
    });
    const s = setup();
    const recorded = loadFixture("transfer-fetch-paid-then-failed").response.body as Wire;
    s.transfers.set("22222222-2222-4222-8222-222222222222", {
      ...recorded,
      id: "22222222-2222-4222-8222-222222222222",
    });
    const summary = await runReconcile(s.ctx);
    expect(summary.transfers).toBe(1);
    expect(s.stub.count("GET", "/api/v1/transfers/33333333-3333-4333-8333-333333333333")).toBe(0);
    // PAID then CANCELLED found by the poll is still an incident.
    expect((await paymentRow(db().app.db, paid)).transferStatus).toBe("CANCELLED");
    const audit = await listAudit(repoCtx(db().app.db, paid.businessId));
    expect(audit.map((a) => a.action)).toEqual(["incident.paid_then_failed"]);
  });

  it("an UNKNOWN attempt whose lookup finds the transfer becomes CONFIRMED, with zero create POSTs", async () => {
    const recorded = loadFixture("transfer-fetch-local-usd-paid").response.body as Wire;
    // The create call timed out before the transfer id was stored: the payment has none yet.
    const ref = await seedPayment(db().app.db, db().appUrl);
    const ctx = repoCtx(db().app.db, ref.businessId);
    const requestId = recorded.request_id as RequestId;
    const attempt = await createAttempt(ctx, { kind: "transfer", refId: ref.paymentId, requestId });
    await updateAttemptStatus(ctx, attempt.id, "UNKNOWN");
    const s = setup();
    s.transfers.set(recorded.id, recorded);

    const summary = await runReconcile(s.ctx);

    expect(summary).toMatchObject({ attemptsConfirmed: 1, attemptsUnresolved: 0, errors: 0 });
    const resolved = await getAttempt(ctx, attempt.id);
    expect(resolved?.status).toBe("CONFIRMED");
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(resolved?.response).toMatchObject({ transferId: recorded.id, status: "SENT" });
    // The lookup went by request_id, and the payment is now linked to the transfer.
    const lookups = s.stub.calls.filter((c) => c.path === "/api/v1/transfers");
    expect(lookups.map((c) => c.url.searchParams.get("request_id"))).toEqual([requestId]);
    const row = await paymentRow(db().app.db, ref);
    expect(row.transferId).toBe(recorded.id);
    expect(row.transferStatus).toBe("SENT");
    expect(s.posts()).toEqual([]);
    expect(s.stub.count("POST", "/api/v1/transfers/create")).toBe(0);
  });

  it("an UNKNOWN attempt the lookup cannot find stays UNKNOWN with an alert line and no new request", async () => {
    const ref = await seedPayment(db().app.db, db().appUrl);
    const ctx = repoCtx(db().app.db, ref.businessId);
    const attempt = await createAttempt(ctx, {
      kind: "transfer",
      refId: ref.paymentId,
      requestId: newRequestId(),
    });
    await updateAttemptStatus(ctx, attempt.id, "UNKNOWN");
    const s = setup();

    const summary = await runReconcile(s.ctx);

    expect(summary).toMatchObject({ attemptsConfirmed: 0, attemptsUnresolved: 1 });
    expect((await getAttempt(ctx, attempt.id))?.status).toBe("UNKNOWN");
    const alert = s.logger.lines.find((l) => l.obj.alert === "attempt_unresolved");
    expect(alert?.level).toBe("error");
    expect(alert?.obj.attemptId).toBe(attempt.id);
    expect(s.posts()).toEqual([]);
  });

  it("one failing fetch does not stop the pass", async () => {
    await seedPayment(db().app.db, db().appUrl, {
      transferId: "44444444-4444-4444-8444-444444444444", // the stub answers 404
      status: "SCHEDULED",
      updatedAt: new Date("2026-11-03T09:00:00Z"),
    });
    const recorded = loadFixture("transfer-fetch-local-usd-paid").response.body as Wire;
    const ok = await seedPayment(db().app.db, db().appUrl, {
      transferId: recorded.id,
      status: "SCHEDULED",
      updatedAt: new Date("2026-11-03T09:43:20Z"),
    });
    const s = setup();
    s.transfers.set(recorded.id, recorded);
    const summary = await runReconcile(s.ctx);
    expect(summary).toMatchObject({ transfers: 2, transfersApplied: 1, errors: 1 });
    expect((await paymentRow(db().app.db, ok)).transferStatus).toBe("SENT");
  });
});
