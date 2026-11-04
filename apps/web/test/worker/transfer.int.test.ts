// transfer.sync and rfi.sync end to end: recorded delivery -> route -> outbox -> worker -> fetch
// (stubbed from recorded responses) -> applyTransferUpdate. AC 6, 7, 8 and BL-01 6623995507.
import { readFileSync } from "node:fs";
import { listAudit, repoCtx } from "@carnet/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../../src/app/api/webhooks/airwallex/route";
import { closeAppDb } from "../../src/server/db";
import { memoryLogger } from "../../src/server/log";
import { createWorker } from "../../src/worker/loop";
import { defaultRegistry } from "../../src/worker/run";
import {
  blockedCalls,
  delivery,
  FetchStub,
  loadFixture,
  makeClient,
  paymentRow,
  query,
  recordedDeliveries,
  recordedRfi,
  seedPayment,
  signedHeaders,
  TEST_WEBHOOK_SECRET,
  transferRoute,
  WEBHOOK_DIR,
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
beforeEach(async () => {
  await query(db().appUrl, "DELETE FROM outbox_jobs");
  await query(db().appUrl, "DELETE FROM webhook_events");
});

type Wire = Record<string, unknown> & { id: string; status: string; updated_at: string };

/** Posts a (possibly rewritten) event body to the route, signed with the test secret. */
async function post(body: string): Promise<void> {
  const res = await POST(webhookRequest(body, signedHeaders(body)));
  expect(res.status).toBe(200);
}

function harness() {
  const stub = new FetchStub();
  const current = new Map<string, Wire>();
  transferRoute(stub, (id) => current.get(id));
  stub.on("GET", /^\/api\/v1\/rfis\/[^/]+$/, (call) =>
    Response.json(recordedRfi(call.path.split("/").pop() ?? "")),
  );
  const logger = memoryLogger();
  const worker = createWorker({
    db: db().app.db,
    registry: defaultRegistry(),
    airwallex: makeClient(stub),
    logger,
    reconcileEveryMs: null,
  });
  const drain = async () => {
    while (await worker.tick()) {
      /* run every due job */
    }
  };
  return { stub, current, logger, worker, drain };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((x, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((p) => [x, ...p]),
  );
}

describe("AC6: out-of-order delivery of one transfer's events", () => {
  // Transfer b9d31842: SCHEDULED (06:05:43), PROCESSING (06:05:43, same second), SENT, PAID.
  const files = [
    "payout.transfer.scheduled.2",
    "payout.transfer.processing.2",
    "payout.transfer.sent.1",
    "payout.transfer.paid.1",
  ];

  it("all 24 permutations store the in-order result; the fetched object wins over the payload", async () => {
    const events = files.map((f) => delivery(f).event);
    expect(new Set(events.map((e) => (e.data as Wire).id)).size).toBe(1);
    const perms = permutations(events.map((_, i) => i));
    expect(perms).toHaveLength(24);

    const h = harness();
    const results: { status: string | null; updatedAt: string | null }[] = [];
    for (const [p, order] of perms.entries()) {
      // A distinct transfer and event ids per permutation, so the runs do not share rows.
      const transferId = `00000000-0000-4000-8000-${String(p).padStart(12, "0")}`;
      const ref = await seedPayment(db().app.db, db().appUrl, { transferId });
      for (const i of order) {
        const e = events[i];
        if (!e) throw new Error("missing event");
        const snapshot = { ...(e.data as Wire), id: transferId };
        // What GET /transfers/{id} returns at the time this event is handled.
        h.current.set(transferId, snapshot);
        // The webhook body lies about the status: the handler must never read it.
        const body = JSON.stringify({
          ...e,
          id: `${e.id.slice(0, 24)}${String(p * 10 + i).padStart(12, "0")}`,
          data: { ...snapshot, status: "CANCELLED" },
        });
        await post(body);
        await h.drain();
      }
      const row = await paymentRow(db().app.db, ref);
      results.push({
        status: row.transferStatus,
        updatedAt: row.transferUpdatedAt?.toISOString() ?? null,
      });
    }

    // In order, the last state is PAID at 06:05:57.
    const inOrder = { status: "PAID", updatedAt: "2026-11-04T06:05:57.000Z" };
    expect(results).toEqual(perms.map(() => inOrder));
    expect(h.stub.count("GET", /^\/api\/v1\/transfers\//)).toBe(24 * 4);
  });
});

describe("AC7: PAID then FAILED", () => {
  // transfer-fetch-paid-then-failed (M0-03): PAID at 09:43:50, then read back CANCELLED at 09:43:51
  // with failure INCORRECT_ROUTING. Both terminal names are checked.
  for (const terminal of ["CANCELLED", "FAILED"] as const) {
    it(`PAID then ${terminal} writes an incident record and an incident log marker`, async () => {
      const recorded = loadFixture("transfer-fetch-paid-then-failed").response.body as Wire;
      const ref = await seedPayment(db().app.db, db().appUrl, {
        transferId: `${recorded.id.slice(0, 30)}${terminal === "FAILED" ? "aaaaaa" : "bbbbbb"}`,
        status: "PAID",
        updatedAt: new Date("2026-11-03T09:43:50Z"),
      });
      const row0 = await paymentRow(db().app.db, ref);
      const transferId = row0.transferId ?? "";
      const h = harness();
      h.current.set(transferId, { ...recorded, id: transferId, status: terminal });

      const paid = delivery("payout.transfer.paid.1").event;
      await post(
        JSON.stringify({
          ...paid,
          id: crypto.randomUUID(),
          name: `payout.transfer.${terminal.toLowerCase()}`,
          data: { ...(paid.data as Wire), id: transferId },
        }),
      );
      await h.drain();

      const row = await paymentRow(db().app.db, ref);
      expect(row.transferStatus).toBe(terminal);
      expect(row.failureType).toBe("INCORRECT_ROUTING");
      const audit = await listAudit(repoCtx(db().app.db, ref.businessId));
      expect(audit.map((a) => a.action)).toEqual(["incident.paid_then_failed"]);
      expect(audit[0]?.data).toMatchObject({
        kind: "PAID_THEN_FAILED",
        from: "PAID",
        to: terminal,
      });
      const marker = h.logger.lines.find((l) => l.obj.incident === "PAID_THEN_FAILED");
      expect(marker?.level).toBe("error");
      expect(marker?.obj.paymentId).toBe(ref.paymentId);
    });
  }

  it("FAILED then CANCELLED (one simulated failure, two webhooks) is one incident-free transition", async () => {
    // BL-01 6623995507: the recorded pair for transfer 3e28c6fe, applied after SENT.
    const failed = delivery("payout.transfer.failed.1").event;
    const cancelled = delivery("payout.transfer.cancelled.1").event;
    const sent = delivery("payout.transfer.sent.2").event;
    const transferId = (sent.data as Wire).id;
    const ref = await seedPayment(db().app.db, db().appUrl, { transferId });
    const h = harness();
    for (const e of [sent, cancelled, failed]) {
      h.current.set(transferId, e.data as Wire);
      await post(JSON.stringify(e));
      await h.drain();
    }
    const row = await paymentRow(db().app.db, ref);
    expect(row.transferStatus).toBe("CANCELLED");
    expect(row.transferUpdatedAt?.toISOString()).toBe("2026-11-04T06:06:20.000Z");
    expect(await listAudit(repoCtx(db().app.db, ref.businessId))).toEqual([]);
  });
});

describe("AC8: RFI events never change payments.transfer_status", () => {
  it("rfi.action_required, answered and closed leave the payment exactly as it was", async () => {
    const ref = await seedPayment(db().app.db, db().appUrl, {
      transferId: "11111111-1111-4111-8111-111111111111",
      status: "SENT",
      updatedAt: new Date("2026-11-04T06:05:50Z"),
    });
    const before = await paymentRow(db().app.db, ref);
    const h = harness();
    const rfiFiles = recordedDeliveries().filter((d) => d.event.name.startsWith("rfi."));
    // rfi.closed.1 was redelivered once (the receiver answered 500 the first time).
    expect(rfiFiles.map((d) => d.event.name).sort()).toEqual([
      "rfi.action_required",
      "rfi.answered",
      "rfi.closed",
      "rfi.closed",
    ]);
    for (const d of rfiFiles) await post(d.body);
    await h.drain();

    const after = await paymentRow(db().app.db, ref);
    expect(after.transferStatus).toBe(before.transferStatus);
    expect(after.transferUpdatedAt).toEqual(before.transferUpdatedAt);
    expect(after.updatedAt).toEqual(before.updatedAt);
    // The RFI was fetched (never trusted from the payload), and no transfer was fetched or changed.
    expect(h.stub.count("GET", /^\/api\/v1\/rfis\//)).toBe(3); // one per distinct event
    expect(h.stub.count("GET", /^\/api\/v1\/transfers/)).toBe(0);
    const jobs = await query<{ kind: string; status: string }>(
      db().appUrl,
      "SELECT kind, status FROM outbox_jobs",
    );
    expect(jobs.every((j) => j.kind === "rfi.sync" && j.status === "DONE")).toBe(true);
    const unprocessed = await query(
      db().appUrl,
      "SELECT 1 FROM webhook_events WHERE processed_at IS NULL",
    );
    expect(unprocessed).toEqual([]);
  });
});

describe("BL-01 6623995507: every recorded delivery, in recorded delivery order", () => {
  it("funding events, the FAILED/CANCELLED pair and out-of-order arrivals settle on the latest state", async () => {
    const order = JSON.parse(readFileSync(`${WEBHOOK_DIR}_delivery-order.json`, "utf8")) as {
      event_id: string;
      object_id: string;
      name: string;
    }[];
    await query(db().appUrl, "DELETE FROM payments"); // earlier tests linked some of these transfers
    const byId = new Map(recordedDeliveries().map((d) => [d.event.id, d]));
    // The order file lists 61 deliveries across two runs; the 25 bodies kept as fixtures cover three
    // transfers and one RFI. Replay those, in the order they arrived.
    const replay = order.filter((o) => byId.has(o.event_id));
    expect(replay).toHaveLength(25);
    const h = harness();
    const refs = new Map<string, Awaited<ReturnType<typeof seedPayment>>>();
    for (const o of replay) {
      if (o.name.startsWith("payout.") && !refs.has(o.object_id)) {
        refs.set(
          o.object_id,
          await seedPayment(db().app.db, db().appUrl, { transferId: o.object_id }),
        );
      }
    }
    const names = new Set<string>();
    for (const o of replay) {
      const d = byId.get(o.event_id);
      if (!d) throw new Error(`no delivery for ${o.event_id}`);
      names.add(o.name);
      if (o.name.startsWith("payout.")) h.current.set(o.object_id, d.event.data as Wire);
      await post(d.body);
      await h.drain();
    }
    expect(names).toContain("payout.transfer.funding.funded");
    expect(names).toContain("payout.transfer.failed");
    expect(names).toContain("payout.transfer.cancelled");
    const final: Record<string, string | null> = {};
    for (const [transferId, ref] of refs) {
      final[transferId] = (await paymentRow(db().app.db, ref)).transferStatus;
    }
    expect(final).toEqual({
      // processing arrived before scheduled, both stamped 06:05:15: rank decides
      "dc23bf4c-28cf-4aa0-b38b-c0c29389aac1": "PROCESSING",
      "b9d31842-bc29-4711-bf0c-bd62c75529ac": "PAID",
      "3e28c6fe-5601-4a15-9623-9c3cda2592bf": "CANCELLED",
    });
    const jobs = await query<{ status: string }>(db().appUrl, "SELECT status FROM outbox_jobs");
    expect(jobs.length).toBe(23);
    expect(jobs.every((j) => j.status === "DONE")).toBe(true);
  });
});
