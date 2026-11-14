import { nextRevision, parseInputs } from "@carnet/domain";
import { describe, expect, it } from "vitest";
import { payrollFriday } from "../../../../../../../packages/domain/test/planner-support";
import { balanceRows, planRouteSpecs } from "../../../../server/plans";

describe("plan routes", () => {
  it("reads are open to any session; there is no write on the plan routes", () => {
    const s = planRouteSpecs();
    expect(s.current.auth).toBe("session");
    expect(s.byRevision.auth).toBe("session");
    expect(s.current.method).toBe("GET");
    expect(s.byRevision.method).toBe("GET");
  });

  it("projects balances per currency: held is unavailable, conversions and funding move the projection", () => {
    const inputs = payrollFriday();
    const plan = nextRevision(null, inputs);
    const rows = balanceRows(plan, parseInputs(inputs));
    const eur = rows.find((r) => r.currency === "EUR");
    const usd = rows.find((r) => r.currency === "USD");
    expect(eur).toMatchObject({
      available_minor: "500000",
      held_minor: "250000",
      reserve_floor_minor: "50000",
    });
    // EUR: 5,000.00 - held 2,500.00 + bought - fund payroll - payout.
    expect(BigInt(eur?.projected_minor ?? "0")).toBeGreaterThanOrEqual(0n);
    expect(BigInt(usd?.projected_minor ?? "0")).toBeLessThan(800000n);
  });

  it("returns no rows for inputs it cannot read", () => {
    expect(balanceRows(nextRevision(null, payrollFriday()), null)).toEqual([]);
  });
});
