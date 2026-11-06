import { PLAN_ACTION_KINDS } from "@carnet/domain";
import { describe, expect, it } from "vitest";
import * as db from "../index";
import * as planRepo from "../repos/plans";
import { PLAN_ACTION_KIND_VALUES } from "../schema/plans";

describe("plan repository surface (append-only)", () => {
  it("exports only insert and read functions: no update, delete, upsert or truncate", () => {
    const names = Object.keys(planRepo).filter(
      (n) => typeof (planRepo as Record<string, unknown>)[n] === "function",
    );
    expect(names.sort()).toEqual([
      "getLatestPlan",
      "getPlanByRevision",
      "insertPlanRevision",
      "listPlanRevisions",
    ]);
    const all = Object.keys(db).filter((n) => /plan/i.test(n));
    for (const n of all)
      expect(n, n).not.toMatch(/update|delete|remove|upsert|truncate|set|save|replace/i);
  });

  it("the schema's action kinds equal the domain's", () => {
    expect([...PLAN_ACTION_KIND_VALUES]).toEqual([...PLAN_ACTION_KINDS]);
  });
});
