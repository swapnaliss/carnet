// plan.rerun (M3-02 AC 6): a recorded event sequence built from the M0-04 check 8 balance fixtures
// (before the transfer, after it was created, while its RFI was open, after the RFI closed) produces
// a new plan revision only when the planner's inputs changed, and a replayed event produces none.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createBusiness, getLatestPlan, listPlanRevisions, repoCtx } from "@carnet/db";
import { type BusinessId, type PlanInputsInput, parseMajor } from "@carnet/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { memoryLogger } from "../../src/server/log";
import { createRegistry } from "../../src/worker/handlers/index";
import {
  enqueuePlanRerun,
  type PlanInputsLoader,
  registerPlanHandlers,
} from "../../src/worker/handlers/plan";
import { createWorker } from "../../src/worker/loop";
import { query, webTestDatabase } from "../support";

const db = webTestDatabase();
const FIXTURES = fileURLToPath(new URL("../../../../fixtures/airwallex/", import.meta.url));

function usdAvailable(file: string): string {
  const fixture = JSON.parse(readFileSync(`${FIXTURES}${file}`, "utf8")) as {
    response: { body: { currency: string; available_amount: number }[] };
  };
  const usd = fixture.response.body.find((b) => b.currency === "USD");
  if (!usd) throw new Error(`no USD row in ${file}`);
  return parseMajor(String(usd.available_amount), "USD").minor.toString();
}

const STATES = {
  beforeTransfer: {
    balance: usdAvailable("rfi-check8-balances-before-transfer.json"),
    held: false,
  },
  afterCreate: {
    balance: usdAvailable("rfi-check8-balances-after-create.json"),
    held: false,
  },
  processing: { balance: usdAvailable("rfi-check8-balances-processing.json"), held: false },
  rfiOpen: { balance: usdAvailable("rfi-check8-balances-rfi-open.json"), held: true },
  afterClose: { balance: usdAvailable("rfi-check8-balances-after-close.json"), held: false },
} as const;

let state: { balance: string; held: boolean } = STATES.beforeTransfer;

// Payroll sized between the balance before the transfer and the balance after it: the transfer's
// debit is what makes it short, so the plan changes with the balance.
const load: PlanInputsLoader = async (_db, businessId, now): Promise<PlanInputsInput> => ({
  businessId,
  now: now.toISOString(),
  balances: [{ businessId, currency: "USD", availableMinor: state.balance }],
  held: state.held
    ? [{ businessId, paymentId: "pay-held", currency: "USD", amountMinor: "4300" }]
    : [],
  obligations: [
    {
      businessId,
      id: "ob-payroll",
      payee: "Payroll",
      amountMinor: parseMajor("9997760", "USD").minor,
      currency: "USD",
      dueAt: "2026-11-06T09:00:00.000Z",
      criticality: 1,
      paymentId: null,
      payoutMethod: "LOCAL",
    },
  ],
  reserveFloor: [],
  fxRates: [],
  config: {
    swiftPayoutFee: [],
    fxSpreadBps: 50,
    heldFundsVisibleInBalances: true,
    deferGraceDays: { "2": 7, "3": 14 },
  },
  policy: { version: 1, hash: "policy-v1", autoConvertLimits: [] },
});

let businessId: BusinessId;
beforeAll(async () => {
  businessId = await createBusiness(db().app.db, { name: "plan-rerun" });
});

function worker() {
  return createWorker({
    db: db().app.db,
    registry: registerPlanHandlers(createRegistry(), load),
    airwallex: {} as never,
    logger: memoryLogger(),
    reconcileEveryMs: null,
  });
}

async function event(next: { balance: string; held: boolean }, eventId: string) {
  state = next;
  await enqueuePlanRerun(db().app.db, { businessId, eventId, cause: "airwallex.transfer.updated" });
  const w = worker();
  while (await w.tick()) {
    /* run every due job */
  }
  return (await getLatestPlan(repoCtx(db().app.db, businessId)))?.plan.revision ?? 0;
}

describe("plan.rerun on the recorded hold sequence", () => {
  it("writes a revision only when the inputs changed, and never twice for one event", async () => {
    const seen = [
      await event(STATES.beforeTransfer, "evt-1"),
      await event(STATES.afterCreate, "evt-2"),
      await event(STATES.processing, "evt-3"), // same facts as before
      await event(STATES.rfiOpen, "evt-4"), // the hold appears
      await event(STATES.rfiOpen, "evt-4"), // the same event delivered again
      await event(STATES.rfiOpen, "evt-5"), // a new event, nothing changed
      await event(STATES.afterClose, "evt-6"), // the RFI closed
    ];
    expect(seen).toEqual([1, 2, 2, 3, 3, 3, 4]);

    const revisions = await listPlanRevisions(repoCtx(db().app.db, businessId));
    expect(revisions.map((r) => r.plan.revision)).toEqual([4, 3, 2, 1]);
    const kindOf = (rev: number) =>
      revisions.find((r) => r.plan.revision === rev)?.plan.actions.map((a) => a.kind);
    expect(kindOf(1)).toEqual(["fund"]); // cash before the transfer covers payroll
    expect(kindOf(2)).toEqual(["escalate"]); // the transfer's debit leaves payroll short
    expect(revisions.find((r) => r.plan.revision === 2)?.trigger).toBe("evt-2");

    const revised = await query<{ payload: { revision: number } }>(
      db().appUrl,
      "SELECT payload FROM outbox_jobs WHERE kind = 'plan.revised' ORDER BY created_at",
    );
    expect(revised.map((r) => r.payload.revision)).toEqual([1, 2, 3, 4]);
    const dead = await query(db().appUrl, "SELECT 1 FROM outbox_jobs WHERE status = 'DEAD'");
    expect(dead).toEqual([]);
  });
});
