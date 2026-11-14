import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REASON_CODES } from "@carnet/domain";
import { describe, expect, it } from "vitest";
import { actionStatus, reasonText } from "../../components/plan/format";
import type { ActionDto } from "../../server/plans";
import { t } from "../../strings";

const action = (over: Partial<ActionDto>): ActionDto =>
  ({
    id: "a1",
    seq: 1,
    kind: "fund",
    reason_code: "FUNDED_FROM_BALANCE",
    reason_facts: { spendable_before_minor: "420000" },
    params: { currency: "EUR", buy_currency: "EUR" },
    needs_approval: false,
    state: "PROPOSED",
    state_reason: null,
    approvable: false,
    bound: null,
    bound_unavailable: false,
    auto: null,
    approved_at: null,
    ...over,
  }) as ActionDto;

describe("plan screen copy", () => {
  it("has a sentence for every planner reason code", () => {
    for (const code of REASON_CODES) {
      expect(Object.keys(t.plan.reason)).toContain(code);
      const text = reasonText(action({ reason_code: code }));
      expect(text).not.toBe(code);
      expect(text).not.toMatch(/\{\w+\}/);
    }
  });

  it("formats amounts with Intl, in the action's currency", () => {
    expect(reasonText(action({}))).toContain("EUR 4,200.00");
  });

  it("maps every execution state to a labelled badge", () => {
    for (const state of [
      "APPROVED",
      "AUTO_APPROVED",
      "EXECUTING",
      "DONE",
      "FAILED",
      "SUPERSEDED",
    ] as const) {
      expect(actionStatus(action({ state })).label).toBeTruthy();
    }
    expect(actionStatus(action({ kind: "payout", approvable: true })).label).toBe("Needs approval");
    expect(actionStatus(action({ kind: "defer" })).label).toBe("Recommendation");
  });

  it("keeps prose out of the plan route files", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") ? [p] : [];
      });
    for (const file of walk(import.meta.dirname)) {
      expect(readFileSync(file, "utf8")).not.toMatch(/>[A-Z][a-z]+ [a-z]+ [a-z]+/);
    }
  });
});
