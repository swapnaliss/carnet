import { describe, expect, it } from "vitest";
import {
  type AutoApprovalState,
  type ConversionIntent,
  evaluateAutoApproval,
  makePolicy,
  policyHash,
  rateWithinBounds,
  rateWithinBps,
} from "../index";

const content = {
  reserveFloor: [{ currency: "USD" as const, minor: "10000" }],
  perActionLimit: [{ currency: "USD" as const, minor: "1000" }],
  dailyCap: [{ currency: "USD" as const, minor: "9990" }],
  slippageBps: 100,
  quoteFreshnessSeconds: 300,
};
const policy = makePolicy(1, content);
const NOW = new Date("2026-11-11T10:00:00Z");

const action = (over: Partial<ConversionIntent> = {}): ConversionIntent => ({
  kind: "convert",
  sellCurrency: "USD",
  buyCurrency: "EUR",
  sellMinor: 999n,
  buyMinor: 880n,
  swiftFeeIncludedMinor: 0n,
  obligationCount: 1,
  indicativeRate: "0.8840",
  ...over,
});
const state = (over: Partial<AutoApprovalState> = {}): AutoApprovalState => ({
  now: NOW,
  balances: [
    { currency: "USD", availableMinor: 1_000_000n },
    { currency: "EUR", availableMinor: 5_000n },
  ],
  autoApprovedTodayMinor: 0n,
  swiftPayoutFeeMinor: 1341n,
  ...over,
});

describe("policy hash", () => {
  it("is stable for equal content and changes with any edit", () => {
    expect(policy.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(makePolicy(2, content).hash).toBe(policy.hash);
    expect(policyHash({ ...content, slippageBps: 101 })).not.toBe(policy.hash);
    expect(policyHash({ ...content, dailyCap: [{ currency: "USD", minor: "9991" }] })).not.toBe(
      policy.hash,
    );
  });
  it("ignores row order", () => {
    const two = {
      ...content,
      reserveFloor: [
        { currency: "USD" as const, minor: "10000" },
        { currency: "EUR" as const, minor: "5" },
      ],
    };
    const swapped = { ...two, reserveFloor: [...two.reserveFloor].reverse() };
    expect(policyHash(two)).toBe(policyHash(swapped));
  });
  it("rejects a duplicate currency", () => {
    expect(() =>
      makePolicy(1, {
        ...content,
        dailyCap: [
          { currency: "USD", minor: "1" },
          { currency: "USD", minor: "2" },
        ],
      }),
    ).toThrow();
  });
});

describe("evaluateAutoApproval", () => {
  it("allows a conversion inside every bound and reports the new daily total", () => {
    const r = evaluateAutoApproval(action(), state({ autoApprovedTodayMinor: 100n }), policy);
    expect(r).toEqual({ decision: "ALLOW", dailyTotalAfterMinor: 1099n });
  });
  it("denies anything that is not a conversion", () => {
    for (const kind of ["payout", "fund", "defer", "escalate"] as const) {
      const r = evaluateAutoApproval({ kind }, state(), policy);
      expect(r).toMatchObject({ decision: "DENY", reason: "NOT_CONVERSION" });
    }
  });
  it("denies a floor breach", () => {
    const r = evaluateAutoApproval(
      action(),
      state({ balances: [{ currency: "USD", availableMinor: 10_500n }] }),
      policy,
    );
    expect(r).toMatchObject({ decision: "DENY", reason: "FLOOR_BREACH" });
  });
  it("denies above the per-action limit", () => {
    const r = evaluateAutoApproval(action({ sellMinor: 1001n }), state(), policy);
    expect(r).toMatchObject({ decision: "DENY", reason: "PER_ACTION_LIMIT" });
  });
  it("ten conversions just under the limit reach the cap; the eleventh is DAILY_CAP", () => {
    let total = 0n;
    for (let i = 0; i < 10; i++) {
      const r = evaluateAutoApproval(action(), state({ autoApprovedTodayMinor: total }), policy);
      expect(r.decision).toBe("ALLOW");
      if (r.decision === "ALLOW") total = r.dailyTotalAfterMinor;
    }
    expect(total).toBe(9990n);
    expect(
      evaluateAutoApproval(action(), state({ autoApprovedTodayMinor: total }), policy),
    ).toMatchObject({
      decision: "DENY",
      reason: "DAILY_CAP",
    });
  });
  it("fails closed without a limit or a cap", () => {
    const noLimit = makePolicy(1, { ...content, perActionLimit: [] });
    expect(evaluateAutoApproval(action(), state(), noLimit)).toMatchObject({ reason: "NO_LIMIT" });
    const noCap = makePolicy(1, { ...content, dailyCap: [] });
    expect(evaluateAutoApproval(action(), state(), noCap)).toMatchObject({
      reason: "NO_DAILY_CAP",
    });
  });
  it("denies a fee larger than the configured SWIFT fee allows", () => {
    const a = action({ swiftFeeIncludedMinor: 1342n, buyMinor: 5000n });
    expect(evaluateAutoApproval(a, state(), policy)).toMatchObject({ reason: "FEE_MISMATCH" });
    expect(evaluateAutoApproval(a, state({ swiftPayoutFeeMinor: 1342n }), policy).decision).toBe(
      "ALLOW",
    );
  });

  const quote = (over: { buyMinor?: bigint; issuedAt?: Date } = {}) => ({
    sellCurrency: "USD" as const,
    buyCurrency: "EUR" as const,
    sellMinor: 999n,
    buyMinor: over.buyMinor ?? 883n,
    issuedAt: over.issuedAt ?? new Date("2026-11-11T09:58:00Z"),
  });
  it("checks the fresh quote: within slippage allows, beyond denies, stale denies", () => {
    // approved 0.8840 -> 999 USD ~ 883.12 EUR (88312 minor... here 883 minor units of a 2-dp pair)
    expect(evaluateAutoApproval(action(), state({ quote: quote() }), policy).decision).toBe(
      "ALLOW",
    );
    expect(
      evaluateAutoApproval(action(), state({ quote: quote({ buyMinor: 860n }) }), policy),
    ).toMatchObject({ reason: "SLIPPAGE" });
    expect(
      evaluateAutoApproval(
        action(),
        state({ quote: quote({ issuedAt: new Date("2026-11-11T09:50:00Z") }) }),
        policy,
      ),
    ).toMatchObject({ reason: "QUOTE_STALE" });
    expect(
      evaluateAutoApproval(action({ sellMinor: 998n }), state({ quote: quote() }), policy),
    ).toMatchObject({ reason: "QUOTE_MISMATCH" });
  });
});

describe("rate arithmetic", () => {
  const q = { sellMinor: 10_000n, buyMinor: 8_840n, sell: "USD" as const, buy: "EUR" as const };
  it("compares exactly in basis points", () => {
    expect(rateWithinBps(q, "0.884", 0)).toBe(true);
    expect(rateWithinBps(q, "0.8841", 0)).toBe(false);
    expect(rateWithinBps(q, "0.8841", 2)).toBe(true);
  });
  it("handles currencies with different exponents", () => {
    // 100 USD -> 15000 JPY (0 dp): rate 150
    const j = { sellMinor: 10_000n, buyMinor: 15_000n, sell: "USD" as const, buy: "JPY" as const };
    expect(rateWithinBps(j, "150", 0)).toBe(true);
    expect(rateWithinBps(j, "151", 0)).toBe(false);
  });
  it("bounds are inclusive", () => {
    expect(rateWithinBounds(q, "0.884", "0.884")).toBe(true);
    expect(rateWithinBounds(q, "0.8841", "0.9")).toBe(false);
    expect(rateWithinBounds(q, "0.8", "0.8839")).toBe(false);
  });
});
