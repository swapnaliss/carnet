import { describe, expect, it } from "vitest";
import { ApprovePlanActionBodySchema, planRouteSpecs } from "../../../../server/plans";

describe("plan-action approval route", () => {
  it("needs an owner or approver and is rate limited like every approval", () => {
    const s = planRouteSpecs().approve;
    expect(s.auth).toEqual({ roles: ["owner", "approver"] });
    expect(s.rateLimit).toEqual({ name: "approval", by: "user" });
    expect(s.method).toBe("POST");
  });

  it("takes the revision and the shown fields, and nothing else", () => {
    const ok = { plan_revision: 2, shown: { sell_minor: "100" } };
    expect(ApprovePlanActionBodySchema.safeParse(ok).success).toBe(true);
    expect(ApprovePlanActionBodySchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(ApprovePlanActionBodySchema.safeParse({ plan_revision: 0, shown: {} }).success).toBe(
      false,
    );
    expect(ApprovePlanActionBodySchema.safeParse({ shown: {} }).success).toBe(false);
  });
});
