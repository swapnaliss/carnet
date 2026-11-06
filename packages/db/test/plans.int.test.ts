import { nextRevision, type PlanInputsInput } from "@carnet/domain";
import { describe, expect, it } from "vitest";
import { PlanRevisionConflictError } from "../src/errors";
import { getLatestPlan, getPlanByRevision, insertPlanRevision, repoCtx } from "../src/repos/index";
import { createBusiness } from "../src/repos/system";
import { sqlStateOf, useTestDatabase } from "./harness";

const db = useTestDatabase();

function inputs(businessId: string, eur: string): PlanInputsInput {
  return {
    businessId,
    now: "2026-11-04T09:00:00.000Z",
    balances: [{ businessId, currency: "EUR", availableMinor: eur }],
    held: [],
    obligations: [
      {
        businessId,
        id: "ob-1",
        payee: "P",
        amountMinor: "1000",
        currency: "EUR",
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
      fxSpreadBps: 0,
      heldFundsVisibleInBalances: true,
      deferGraceDays: { "2": 1, "3": 1 },
    },
    policy: { version: 1, hash: "p", autoConvertLimits: [] },
  };
}

describe("plans repository", () => {
  it("stores a revision with its actions, round-trips it, and storing it twice is a no-op", async () => {
    const businessId = await createBusiness(db().app.db, { name: "plans-a" });
    const ctx = repoCtx(db().app.db, businessId);
    const i1 = inputs(businessId, "5000");
    const p1 = nextRevision(null, i1);
    const first = await insertPlanRevision(ctx, p1, { inputs: i1, trigger: "evt-1" });
    expect(first.inserted).toBe(true);
    expect(first.stored.plan).toEqual(p1);
    const again = await insertPlanRevision(ctx, p1, { inputs: i1 });
    expect(again.inserted).toBe(false);
    expect(again.stored.id).toBe(first.stored.id);

    const p2 = nextRevision(p1, inputs(businessId, "6000"));
    expect(p2.revision).toBe(2);
    await insertPlanRevision(ctx, p2, { inputs: inputs(businessId, "6000") });
    expect((await getLatestPlan(ctx))?.plan).toEqual(p2);
    expect((await getPlanByRevision(ctx, 1))?.plan).toEqual(p1);

    // Same revision number, different inputs: a conflict, nothing overwritten.
    const other = nextRevision(null, inputs(businessId, "1"));
    await expect(
      insertPlanRevision(ctx, other, { inputs: inputs(businessId, "1") }),
    ).rejects.toThrow(PlanRevisionConflictError);
    expect((await getPlanByRevision(ctx, 1))?.plan).toEqual(p1);
  });

  it("the app role cannot UPDATE or DELETE plans or plan_actions", async () => {
    for (const sql of [
      "UPDATE plans SET revision = revision",
      "DELETE FROM plans",
      "UPDATE plan_actions SET seq = seq",
      "DELETE FROM plan_actions",
    ]) {
      expect(await sqlStateOf(db().appUrl, sql), sql).toBe("42501");
    }
  });
});
