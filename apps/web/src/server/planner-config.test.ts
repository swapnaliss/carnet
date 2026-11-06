import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PlanInputsInput, plan } from "@carnet/domain";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_FEES_PATH, loadPlannerConfig, plannerConfigFromJson } from "./planner-config";

const dir = mkdtempSync(join(tmpdir(), "m3-02-fees-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fixturePath = join(DEFAULT_FEES_PATH, "../../fixtures/planner/payroll-friday.json");

function payrollFriday(config: PlanInputsInput["config"]): PlanInputsInput {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
  delete fixture._comment;
  return { ...(fixture as unknown as PlanInputsInput), config };
}

function convertSell(config: PlanInputsInput["config"]): bigint {
  const convert = plan(
    payrollFriday({ ...config, heldFundsVisibleInBalances: false }),
  ).actions.find((a) => a.kind === "convert");
  if (convert?.kind !== "convert") throw new Error("no convert in plan");
  return BigInt(convert.params.sell_minor);
}

describe("planner config (config/fees.json)", () => {
  it("loads the repository file: EUR 13.41 SWIFT fee, balance already excludes held funds", () => {
    const config = loadPlannerConfig();
    expect(config.swiftPayoutFee).toEqual([{ currency: "EUR", minor: 1341n }]);
    expect(config.heldFundsVisibleInBalances).toBe(true);
    expect(config.fxSpreadBps).toBeGreaterThan(0);
  });

  it("changing the fee in the file changes the conversion amount in the plan", () => {
    const original = JSON.parse(readFileSync(DEFAULT_FEES_PATH, "utf8")) as {
      swiftPayoutFee: Record<string, string>;
    };
    const changedPath = join(dir, "fees.json");
    writeFileSync(
      changedPath,
      JSON.stringify({ ...original, swiftPayoutFee: { ...original.swiftPayoutFee, EUR: "25.00" } }),
    );
    const before = convertSell(loadPlannerConfig());
    const after = convertSell(loadPlannerConfig(changedPath));
    expect(after).toBeGreaterThan(before);
    // Two payouts each cost 11.59 EUR more; at 0.8847 less 50 bps that is about 26.3 USD more.
    expect(after - before).toBeGreaterThanOrEqual(2600n);
    expect(after - before).toBeLessThanOrEqual(2700n);
  });

  it("rejects a fee for an unknown currency and a malformed amount", () => {
    const base = {
      heldFundsVisibleInBalances: false,
      fxSpreadBps: 10,
      deferGraceDays: { "2": 1, "3": 1 },
    };
    expect(() => plannerConfigFromJson({ ...base, swiftPayoutFee: { XXX: "1.00" } })).toThrow(
      /currency/,
    );
    expect(() => plannerConfigFromJson({ ...base, swiftPayoutFee: { EUR: "1.005" } })).toThrow();
  });
});
