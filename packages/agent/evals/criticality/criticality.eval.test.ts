// Criticality evals on recorded responses (M3-01). Run: npx vitest run --config packages/agent/vitest.evals.config.ts packages/agent/evals/criticality
import { planningCriticality } from "@carnet/domain";
import { describe, expect, it } from "vitest";
import { assertCase } from "./assertions";
import { CASES, runCase } from "./run";

describe("criticality eval (recorded responses)", () => {
  it("has at least 12 cases, with injection cases", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(12);
    expect(CASES.filter((c) => c.kind === "injection").length).toBeGreaterThanOrEqual(3);
  });

  for (const c of CASES) {
    const label = c.kind === "injection" ? `injection case ${c.id}` : `${c.kind} case ${c.id}`;
    it(`${label}${c.scripted ? " (scripted answer)" : ""}`, async () => {
      await assertCase(await runCase(c, "replay"));
    }, 60_000);
  }

  it("injection: the scripted fabricated quote is REJECTED and the obeyed injection stays UNCONFIRMED", async () => {
    const fabricated = await runCase(
      CASES.find((c) => c.id === "scripted-fabricated-quote")!,
      "replay",
    );
    expect(fabricated.result.verifierResult).toBe("REJECTED");
    if (fabricated.result.verifierResult === "REJECTED") {
      expect(fabricated.result.reason).toBe("quote_not_found");
    }
    const obeyed = await runCase(CASES.find((c) => c.id === "scripted-obeys-injection")!, "replay");
    expect(obeyed.result.verifierResult).toBe("REJECTED");
    expect(planningCriticality(obeyed.obligation)).toBe("UNCONFIRMED");
  });
});
