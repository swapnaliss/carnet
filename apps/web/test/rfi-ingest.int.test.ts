// M2-04 ACs 1, 2, 3, 5, 6, 8 end to end: recorded RFI webhooks and fetches (M0-04 / M0-05) -> route ->
// outbox -> worker -> fetch (stubbed from recorded bodies) -> rfis / rfi_questions / outbox / audit.
import { getRfi, listAudit, listRfiQuestions, paymentHasHoldingRfi, repoCtx } from "@carnet/db";
import { project, type RfiId, type TransferStatus } from "@carnet/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../src/app/api/webhooks/airwallex/route";
import { closeAppDb } from "../src/server/db";
import { runReconcile } from "../src/worker/reconcile";
import {
  closedUnanswered,
  firstRoundOpen,
  fixtureRfi,
  followUpSequence,
  newBusiness,
  type RfiWire,
  resetRfiTables,
  retarget,
  rfiEventBody,
  rfiHarness,
  uid,
  withoutSources,
} from "./rfi-support";
import {
  blockedCalls,
  loadFixture,
  paymentRow,
  query,
  recordedDeliveries,
  seedPayment,
  signedHeaders,
  TEST_WEBHOOK_SECRET,
  webhookRequest,
  webTestDatabase,
} from "./support";

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
  await resetRfiTables(db().appUrl);
});

async function post(body: string): Promise<void> {
  expect((await POST(webhookRequest(body, signedHeaders(body)))).status).toBe(200);
}

const rfiRows = (appUrl = db().appUrl) =>
  query<{
    id: string;
    business_id: string;
    state: string;
    round: number;
    payment_id: string | null;
    orphan_reason: string | null;
    conflict: boolean;
  }>(appUrl, "SELECT * FROM rfis ORDER BY created_at");
const draftJobs = () =>
  query<{ payload: { rfiId: string; round: number; businessId: string } }>(
    db().appUrl,
    "SELECT payload FROM outbox_jobs WHERE kind = 'rfi.draft' ORDER BY (payload->>'round')::int, created_at",
  );

describe("AC1: recorded RFI webhooks create the RFI, its questions and DRAFTING, with one rfi.draft job", () => {
  it("replays rfi.action_required, answered and closed (and the redelivery) for the recorded RFI", async () => {
    const hook = recordedDeliveries().find((d) => d.event.name === "rfi.action_required");
    if (!hook) throw new Error("no recorded rfi.action_required");
    const rfiId = (hook.event.data as { id: string }).id; // d723bf59, M0-05
    const accountId = (hook.event as unknown as { account_id: string }).account_id;
    const { businessId } = await newBusiness(db().app.db);
    await query(db().appUrl, "UPDATE businesses SET airwallex_account_id = $1 WHERE id = $2", [
      accountId,
      businessId,
    ]);
    const h = rfiHarness(db().app.db);
    // What GET /rfis/{id} returns: the recorded fetch (rfi-check1-fetch: two questions, TRANSFER sources
    // unknown to this business), keyed to the webhook's RFI and account.
    h.current.set(rfiId, retarget(fixtureRfi("rfi-check1-fetch"), { id: rfiId, accountId }));

    for (const d of recordedDeliveries().filter((x) => x.event.name.startsWith("rfi."))) {
      await post(d.body);
      await h.drain();
    }

    const [rfi, ...rest] = await rfiRows();
    expect(rest).toEqual([]);
    expect(rfi).toMatchObject({ business_id: businessId, state: "DRAFTING", round: 1 });
    const qs = await listRfiQuestions(repoCtx(db().app.db, businessId), rfi?.id as RfiId);
    expect(qs.map((q) => [q.round, q.answerType, q.needsDrafting])).toEqual([
      [1, "TEXT", true],
      [1, "ATTACHMENT", true],
    ]);
    const jobs = await draftJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({ businessId, rfiId: rfi?.id, round: 1 });
    const audit = await listAudit(repoCtx(db().app.db, businessId));
    expect(audit.map((a) => a.action).filter((a) => a === "rfi.transition")).toHaveLength(1);
    expect(audit.map((a) => a.action)).toContain("rfi.created");
    // The payload was never trusted: one fetch per distinct event, all webhook events processed.
    expect(
      await query(db().appUrl, "SELECT 1 FROM webhook_events WHERE processed_at IS NULL"),
    ).toEqual([]);
  });
});

describe("AC2: matching to a payment, and the orphan queue with distinct reason codes", () => {
  async function ingest(wire: RfiWire, h = rfiHarness(db().app.db)) {
    h.current.set(wire.id, wire);
    await post(rfiEventBody(wire.id));
    await h.drain();
    return h;
  }

  it("a question sourced from a known TRANSFER links to that payment and the payment is held", async () => {
    const transferId = uid("aaaaaaaa");
    const ref = await seedPayment(db().app.db, db().appUrl, {
      transferId,
      status: "PROCESSING",
      updatedAt: new Date("2026-11-03T09:57:00Z"),
    });
    const wire = retarget(fixtureRfi("rfi-check1-fetch"), {
      id: uid("bbbbbbbb"),
      accountId: "acct_not_mapped",
      transferId,
    });
    await ingest(wire); // no account mapping: attributed by the transfer's owner
    const [rfi] = await rfiRows();
    expect(rfi).toMatchObject({
      business_id: ref.businessId,
      payment_id: ref.paymentId,
      orphan_reason: null,
      state: "DRAFTING",
    });
    const rc = repoCtx(db().app.db, ref.businessId);
    const pay = await paymentRow(db().app.db, ref);
    const holding = await paymentHasHoldingRfi(rc, ref.paymentId);
    expect(project(pay.transferStatus as TransferStatus, holding)).toEqual({
      view: "PROCESSING",
      held: true,
      final: false,
    });
  });

  const base = () => fixtureRfi("rfi-check1-fetch");
  const cases: { reason: string; build: (a: string, b: string) => RfiWire }[] = [
    { reason: "NO_SOURCES", build: () => withoutSources(base()) },
    {
      // The simulator's synthetic DEPOSIT source (rfi-check7-fetch-no-sources), the only orphan the
      // sandbox can create (BL-01 6600618153).
      reason: "NON_TRANSFER_SOURCE",
      build: () => retarget(base(), { sources: [{ id: "SIMULATION_526af406", type: "DEPOSIT" }] }),
    },
    {
      reason: "UNKNOWN_TRANSFER",
      build: () => retarget(base(), { transferId: "not-a-transfer-of-ours" }),
    },
    {
      // Injected (the sandbox keeps only one source per question): two questions, two payments.
      reason: "MULTIPLE_PAYMENTS",
      build: (a, b) => {
        const w = retarget(base(), { transferId: a });
        const second = w.active_request?.questions[1];
        if (second) second.sources = [{ id: b, type: "TRANSFER" }];
        return w;
      },
    },
  ];

  it.each(cases)("$reason goes to the orphan queue", async ({ reason, build }) => {
    const { businessId, accountId } = await newBusiness(db().app.db);
    const ta = uid("cccccccc");
    const tb = uid("dddddddd");
    const rc = repoCtx(db().app.db, businessId);
    for (const t of [ta, tb]) {
      const p = await seedPayment(db().app.db, db().appUrl, {
        transferId: t,
        status: "PROCESSING",
        updatedAt: new Date("2026-11-03T09:57:00Z"),
      });
      await query(db().appUrl, "UPDATE payments SET business_id = $1 WHERE id = $2", [
        businessId,
        p.paymentId,
      ]);
    }
    const wire = { ...build(ta, tb), account_id: accountId, id: uid("eeeeeeee") };
    await ingest(wire);
    const [rfi] = await rfiRows();
    expect(rfi).toMatchObject({ business_id: businessId, payment_id: null, orphan_reason: reason });
    expect(
      await paymentHasHoldingRfi(
        rc,
        (
          await query<{ id: string }>(
            db().appUrl,
            "SELECT id FROM payments WHERE business_id = $1 LIMIT 1",
            [businessId],
          )
        )[0]?.id as never,
      ),
    ).toBe(false);
  });
});

describe("AC3: duplicate, stale and permuted deliveries end in the same state", () => {
  function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items];
    return items.flatMap((x, i) =>
      permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((p) => [x, ...p]),
    );
  }

  it("all 24 orderings of the follow-up sequence (plus a duplicate) store ANSWERED, round 2", async () => {
    const { businessId, accountId } = await newBusiness(db().app.db);
    const seq = followUpSequence();
    const perms = permutations([0, 1, 2, 3]);
    expect(perms).toHaveLength(24);
    const h = rfiHarness(db().app.db);
    const finals: { state: string; round: number; version: string }[] = [];
    for (const [p, order] of perms.entries()) {
      const id = uid("ffffffff");
      const transferId = uid("99999999");
      for (const i of [...order, order[0] as number]) {
        const snap = seq[i];
        if (!snap) throw new Error("missing snapshot");
        h.current.set(id, retarget(snap, { id, accountId, transferId }));
        await post(rfiEventBody(id));
        await h.drain();
      }
      const [row] = await query<{
        state: string;
        round: number;
        airwallex_updated_at: Date;
        airwallex_status: string;
      }>(
        db().appUrl,
        "SELECT state, round, airwallex_updated_at, airwallex_status FROM rfis WHERE airwallex_rfi_id = $1",
        [id],
      );
      finals.push({
        state: row?.state ?? "",
        round: row?.round ?? 0,
        version: `${row?.airwallex_status}@${row?.airwallex_updated_at.toISOString()}`,
      });
      expect(p).toBeGreaterThanOrEqual(0);
    }
    const inOrder = { state: "ANSWERED", round: 2, version: "ANSWERED@2026-11-03T09:57:44.000Z" };
    expect(finals).toEqual(perms.map(() => inOrder));
    expect((await rfiRows()).every((r) => r.business_id === businessId)).toBe(true);
  });
});

describe("AC5: a fetched CLOSED RFI while APPROVED or ANSWER_SUBMITTING becomes EXPIRED", () => {
  it.each(["APPROVED", "ANSWER_SUBMITTING"])(
    "%s -> EXPIRED; the PROCESSING transfer is untouched",
    async (state) => {
      const transferId = uid("12121212");
      const updatedAt = new Date("2026-11-03T09:57:00Z");
      const ref = await seedPayment(db().app.db, db().appUrl, {
        transferId,
        status: "PROCESSING",
        updatedAt,
      });
      const before = await paymentRow(db().app.db, ref);
      const id = uid("34343434");
      const h = rfiHarness(db().app.db);
      h.current.set(id, retarget(fixtureRfi("rfi-check1-fetch"), { id, transferId }));
      await post(rfiEventBody(id));
      await h.drain();
      // M2-07 moves the RFI to these states through the state machine; here the row is placed directly.
      await query(db().appUrl, "UPDATE rfis SET state = $1", [state]);

      h.current.set(id, retarget(closedUnanswered(), { id, transferId }));
      await post(rfiEventBody(id, "rfi.closed"));
      await h.drain();

      const [row] = await rfiRows();
      expect(row?.state).toBe("EXPIRED");
      const after = await paymentRow(db().app.db, ref);
      expect(after.transferStatus).toBe("PROCESSING");
      expect(after.transferUpdatedAt).toEqual(before.transferUpdatedAt);
      const holding = await paymentHasHoldingRfi(
        repoCtx(db().app.db, ref.businessId),
        ref.paymentId,
      );
      expect(project("PROCESSING", holding)).toEqual({
        view: "PROCESSING",
        held: false,
        final: false,
      });
    },
  );
});

describe("AC6: follow-up reuses the RFI row, increments round, and leaves round 1 unchanged", () => {
  it("ACTION_REQUIRED r1 -> ANSWERED -> reopened r2", async () => {
    const { businessId, accountId } = await newBusiness(db().app.db);
    const id = uid("56565656");
    const [s1, s2, s3] = followUpSequence().map((s) => retarget(s, { id, accountId }));
    const h = rfiHarness(db().app.db);
    const rc = repoCtx(db().app.db, businessId);
    const feed = async (s: RfiWire | undefined) => {
      if (!s) throw new Error("missing");
      h.current.set(id, s);
      await post(rfiEventBody(id));
      await h.drain();
    };
    await feed(s1);
    const [first] = await rfiRows();
    const round1 = await listRfiQuestions(rc, first?.id as RfiId, 1);
    expect(round1).toHaveLength(2);
    await feed(s2);
    expect((await rfiRows())[0]?.state).toBe("ANSWERED");
    await feed(s3);

    const rows = await rfiRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first?.id, state: "DRAFTING", round: 2 });
    expect(await listRfiQuestions(rc, first?.id as RfiId, 1)).toEqual(round1);
    const round2 = await listRfiQuestions(rc, first?.id as RfiId, 2);
    expect(round2.map((q) => [q.reopened, q.needsDrafting])).toEqual([
      [true, true], // 5f4cbf0a asked again
      [false, true], // a4f64392 is new
    ]);
    expect((await draftJobs()).map((j) => j.payload.round)).toEqual([1, 2]);
    const rfi = await getRfi(rc, first?.id as RfiId);
    expect(rfi?.airwallexAnsweredRequests).toBe(1);
  });
});

describe("AC8: the reconcile poll ingests an RFI whose webhook was missed", () => {
  it("creates it from the recorded list fixture once; a second pass changes nothing", async () => {
    const { businessId, accountId } = await newBusiness(db().app.db);
    const listed = (loadFixture("rfi-check1-list").response.body as { items: RfiWire[] }).items.map(
      (r) => retarget(r, { accountId }),
    );
    expect(listed).toHaveLength(1);
    const h = rfiHarness(db().app.db);
    for (const r of listed) h.current.set(r.id, r);
    expect(await query(db().appUrl, "SELECT 1 FROM webhook_events")).toEqual([]);
    const ctx = { db: db().app.db, airwallex: h.airwallex, logger: h.logger };

    const first = await runReconcile(ctx);
    expect(first.rfis).toBe(1);
    const rows = await rfiRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ business_id: businessId, state: "DRAFTING" });
    expect(await draftJobs()).toHaveLength(1);

    await runReconcile(ctx);
    expect(await rfiRows()).toHaveLength(1);
    expect(await draftJobs()).toHaveLength(1);
    // The poll asks for TRANSACTION RFIs in all three statuses.
    const call = h.stub.calls.find((c) => c.path === "/api/v1/rfis");
    expect(call?.url.searchParams.get("types")).toBe("TRANSACTION");
    expect(call?.url.searchParams.get("statuses")).toBe("ACTION_REQUIRED,ANSWERED,CLOSED");
  });
});

describe("unattributed RFIs", () => {
  it("an RFI no business can be tied to is logged and not stored", async () => {
    await newBusiness(db().app.db);
    await newBusiness(db().app.db); // two businesses: no 'sole business' fallback
    const id = uid("78787878");
    const h = rfiHarness(db().app.db);
    h.current.set(
      id,
      retarget(firstRoundOpen(), { id, accountId: "acct_unknown", transferId: "t-none" }),
    );
    await post(rfiEventBody(id));
    await h.drain();
    expect(await rfiRows()).toEqual([]);
    expect(h.logger.lines.some((l) => l.obj.alert === "rfi_unattributed")).toBe(true);
  });
});
