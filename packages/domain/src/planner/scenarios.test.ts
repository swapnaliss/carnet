import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { payrollFriday, withoutHold } from "../../test/planner-support";
import { nextRevision, type Plan, type PlanInputsInput, plan } from "./index";

const kinds = (p: Plan) =>
  p.actions.map(
    (a) =>
      `${a.kind}:${"obligation_id" in a.params ? a.params.obligation_id : a.params.sell_currency}`,
  );
const strip = (p: Plan) => p.actions.map(({ seq: _seq, ...rest }) => rest);

/** Independent of plan.ts: smallest USD minor that buys `buyMinor` EUR minor at 0.8847 less 50 bps. */
function expectedSell(buyMinor: bigint): bigint {
  // rate 0.8847 = 8847 / 10^4, worst case x (10000 - 50) / 10000; both currencies have 2 decimals.
  const num = buyMinor * 10n ** 4n * 10_000n;
  const den = 8847n * 9950n;
  return (num + den - 1n) / den;
}

describe("planner scenarios", () => {
  it("payroll Friday with one held payment: convert, fund payroll, alternate payout, defer the bill", () => {
    const p = plan(payrollFriday());
    expect(p.actions.map((a) => a.kind)).toEqual(["convert", "fund", "payout", "defer"]);

    const [convert, fund, payout, defer] = p.actions;
    // EUR spendable = 5,000.00 - held 2,500.00 - floor 500.00 = 2,000.00. Payroll needs 4,000.00 +
    // the 13.41 SWIFT fee from config/fees.json; the alternate payout needs 2,500.00 + 13.41.
    const buy = 401341n - 200000n + 251341n;
    if (convert?.kind !== "convert") throw new Error("expected convert");
    expect(convert.params).toMatchObject({
      sell_currency: "USD",
      buy_currency: "EUR",
      buy_minor: buy.toString(),
      sell_minor: expectedSell(buy).toString(),
      swift_fee_included_minor: "2682",
      rate: "0.8847",
      auto_eligible: false,
      obligation_ids: ["ob-payroll", "ob-supplier"],
    });
    expect(convert.params.rate_low).toBe("0.88027650");
    expect(convert.params.rate_high).toBe("0.88912350");
    expect(convert.needs_approval).toBe(true); // sell exceeds the auto limit of USD 5,000.00
    expect(convert.reason_code).toBe("CONVERT_SHORTFALL");
    expect(convert.reason_facts).toMatchObject({
      buy_minor: buy.toString(),
      swift_fee_included_minor: "2682",
      fx_spread_bps: 50,
    });

    if (fund?.kind !== "fund") throw new Error("expected fund");
    expect(fund.params).toMatchObject({
      obligation_id: "ob-payroll",
      fee_minor: "1341",
      reserved_minor: "401341",
      criticality: "1",
    });
    expect(fund.reason_code).toBe("FUNDED_AFTER_CONVERSION");
    expect(fund.reason_facts).toMatchObject({
      available_minor: "500000",
      held_minor: "250000",
      held_counted_by_planner: true,
      reserve_floor_minor: "50000",
      spendable_before_minor: "200000",
      covered_by_conversion_minor: "201341",
    });
    expect(fund.needs_approval).toBe(false);

    if (payout?.kind !== "payout") throw new Error("expected payout");
    expect(payout.params).toMatchObject({
      obligation_id: "ob-supplier",
      held_payment_id: "pay-supplier",
      reserved_minor: "251341",
    });
    expect(payout.reason_code).toBe("PAYOUT_ALTERNATE_FOR_HELD");
    expect(payout.needs_approval).toBe(true);

    if (defer?.kind !== "defer") throw new Error("expected defer");
    expect(defer.params).toMatchObject({
      obligation_id: "ob-bill",
      criticality: "3",
      current_due_at: "2026-11-06T09:00:00.000Z",
      proposed_due_at: "2026-11-20T09:00:00.000Z",
    });
    expect(defer.reason_code).toBe("DEFER_SHORT_OF_CASH");
    expect(defer.reason_facts).toMatchObject({ needed_minor: "251341", spendable_minor: "0" });
    expect(p.actions.map((a) => a.seq)).toEqual([1, 2, 3, 4]);
  });

  it("with the balance already excluding held funds (M0-04 check 8) the planner does not subtract again", () => {
    const raw = payrollFriday();
    const netted = {
      ...raw,
      balances: raw.balances.map((b) =>
        b.currency === "EUR" ? { ...b, availableMinor: "250000" } : b,
      ),
      config: { ...raw.config, heldFundsVisibleInBalances: true },
    };
    const decisions = (p: Plan) => p.actions.map((a) => ({ kind: a.kind, params: a.params }));
    expect(decisions(plan(netted))).toEqual(decisions(plan(raw)));
    const fund = plan(netted).actions.find((a) => a.kind === "fund");
    expect(fund?.reason_facts).toMatchObject({ held_counted_by_planner: false });
  });

  it("no hold: the same obligations are plainly funded, no payout", () => {
    const p = plan(withoutHold(payrollFriday()));
    expect(p.actions.find((a) => a.kind === "payout")).toBeUndefined();
    expect(p.actions.filter((a) => a.kind === "fund").map((a) => a.params)).toEqual(
      expect.arrayContaining([expect.objectContaining({ obligation_id: "ob-payroll" })]),
    );
  });

  describe("conversion source (ADR 0021 amendment 1)", () => {
    // An SGD payroll with no SGD on hand; CNY and USD can both cover it.
    const sgdPayroll = (
      autoConvertLimits: { currency: string; minor: string }[],
    ): PlanInputsInput => {
      const base = payrollFriday();
      const biz = base.businessId;
      return {
        ...base,
        held: [],
        reserveFloor: [],
        balances: [
          { businessId: biz, currency: "CNY", availableMinor: "1000000000" },
          { businessId: biz, currency: "USD", availableMinor: "1000000000" },
        ],
        obligations: [
          {
            businessId: biz,
            id: "ob-sgd-payroll",
            payee: "Lion City Payroll Pte. Ltd.",
            amountMinor: "150000",
            currency: "SGD",
            dueAt: "2026-11-06T09:00:00.000Z",
            criticality: 1,
            paymentId: null,
            payoutMethod: "LOCAL",
          },
        ],
        fxRates: [
          { sell: "CNY", buy: "SGD", rate: "0.1850", asOf: "2026-11-03T00:00:00.000Z" },
          { sell: "USD", buy: "SGD", rate: "1.3400", asOf: "2026-11-03T00:00:00.000Z" },
        ],
        policy:
          autoConvertLimits.length === 0
            ? { version: 0, hash: "none", autoConvertLimits: [] }
            : { version: 1, hash: "policy-v1", autoConvertLimits },
      } as PlanInputsInput;
    };
    const convertOf = (p: Plan) => {
      const c = p.actions.find((a) => a.kind === "convert");
      if (c?.kind !== "convert") throw new Error("expected a convert");
      return c;
    };

    it("with a USD-only policy, the SGD shortfall sells USD (auto-eligible) although CNY sorts first", () => {
      const c = convertOf(plan(sgdPayroll([{ currency: "USD", minor: "500000" }])));
      expect(c.params.sell_currency).toBe("USD");
      expect(c.params.auto_eligible).toBe(true);
      expect(c.needs_approval).toBe(false);
    });

    it("with no policy, the source is alphabetical as before (CNY)", () => {
      const c = convertOf(plan(sgdPayroll([])));
      expect(c.params.sell_currency).toBe("CNY");
      expect(c.needs_approval).toBe(true);
    });

    it("a policy limit for every source keeps the alphabetical order", () => {
      const c = convertOf(
        plan(
          sgdPayroll([
            { currency: "CNY", minor: "5000000" },
            { currency: "USD", minor: "500000" },
          ]),
        ),
      );
      expect(c.params.sell_currency).toBe("CNY");
    });

    it("is deterministic: same inputs, same plan and hashes, whatever the order of the rates", () => {
      const a = plan(sgdPayroll([{ currency: "USD", minor: "500000" }]));
      const reversed = sgdPayroll([{ currency: "USD", minor: "500000" }]);
      const b = plan({ ...reversed, fxRates: [...(reversed.fxRates ?? [])].reverse() });
      expect(strip(b)).toEqual(strip(a));
      expect(b.content_hash).toBe(a.content_hash);
      expect(b.inputs_hash).toBe(a.inputs_hash);
    });
  });

  it("hold appears, then is released: the decisions return to the baseline (revisions 1, 2, 3)", () => {
    const baseline = nextRevision(null, withoutHold(payrollFriday()));
    const held = nextRevision(baseline, payrollFriday());
    const released = nextRevision(held, withoutHold(payrollFriday()));
    expect([baseline.revision, held.revision, released.revision]).toEqual([1, 2, 3]);
    expect(strip(held)).not.toEqual(strip(baseline));
    expect(strip(released)).toEqual(strip(baseline));
    expect(released.content_hash).toBe(baseline.content_hash);
    expect(released.inputs_hash).toBe(baseline.inputs_hash);
  });

  it("unconfirmed criticality reserves like criticality 1, is labelled, and is never deferred", () => {
    const base = payrollFriday();
    const inputs: PlanInputsInput = {
      ...base,
      held: [],
      balances: [
        { businessId: "biz-agency", currency: "EUR", availableMinor: "300000" },
        { businessId: "biz-agency", currency: "USD", availableMinor: "0" },
      ],
      obligations: [
        {
          businessId: "biz-agency",
          id: "ob-confirmed-2",
          payee: "A",
          amountMinor: "100000",
          currency: "EUR",
          dueAt: "2026-11-05T09:00:00.000Z",
          criticality: 2,
          paymentId: null,
          payoutMethod: "LOCAL",
        },
        {
          businessId: "biz-agency",
          id: "ob-unconfirmed",
          payee: "B",
          amountMinor: "150000",
          currency: "EUR",
          dueAt: "2026-11-06T09:00:00.000Z",
          criticality: "UNCONFIRMED",
          paymentId: null,
          payoutMethod: "LOCAL",
        },
        {
          businessId: "biz-agency",
          id: "ob-unconfirmed-big",
          payee: "C",
          amountMinor: "999999",
          currency: "USD",
          dueAt: "2026-11-06T09:00:00.000Z",
          criticality: "UNCONFIRMED",
          paymentId: null,
          payoutMethod: "LOCAL",
        },
      ],
      reserveFloor: [],
    };
    const p = plan(inputs);
    // The unconfirmed obligation sorts with criticality 1: before the confirmed 2 that is due earlier.
    expect(
      p.actions.map((a) => ("obligation_id" in a.params ? a.params.obligation_id : null)),
    ).toEqual(["ob-unconfirmed", "ob-unconfirmed-big", "ob-confirmed-2"]);
    const [first, second] = p.actions;
    expect(first).toMatchObject({
      kind: "fund",
      params: { criticality: "UNCONFIRMED", criticality_unconfirmed: true },
    });
    // No USD to cover it, no conversion source: escalated, not deferred, with the unconfirmed code.
    expect(second).toMatchObject({
      kind: "escalate",
      reason_code: "ESCALATE_UNCONFIRMED_SHORT",
      params: { shortfall_minor: "999999", criticality_unconfirmed: true },
    });
    expect(p.actions.some((a) => a.kind === "defer")).toBe(false);
  });

  it("a reserve floor so high that nothing can convert escalates the critical payroll", () => {
    const base = payrollFriday();
    const p = plan({
      ...base,
      reserveFloor: [
        { businessId: "biz-agency", currency: "EUR", minor: "50000" },
        { businessId: "biz-agency", currency: "USD", minor: "800000" },
      ],
    });
    expect(p.actions.some((a) => a.kind === "convert")).toBe(false);
    const payroll = p.actions.find(
      (a) => a.params && "obligation_id" in a.params && a.params.obligation_id === "ob-payroll",
    );
    expect(payroll).toMatchObject({
      kind: "escalate",
      reason_code: "ESCALATE_CRITICAL_SHORT",
      needs_approval: true,
      params: { shortfall_minor: "201341" },
    });
    expect(payroll?.reason_facts).toMatchObject({ reserve_floor_minor: "50000" });
    // Strict priority: the lower-priority obligations in EUR queue behind payroll.
    expect(kinds(p).filter((k) => k.startsWith("fund") || k.startsWith("payout"))).toEqual([]);
  });

  it("two businesses in the same database never mix", () => {
    const a = payrollFriday();
    const rich = {
      ...a,
      businessId: "biz-other",
      balances: a.balances.map((b) => ({
        ...b,
        businessId: "biz-other",
        availableMinor: "999999999",
      })),
      held: [],
      obligations: a.obligations.map((o) => ({ ...o, businessId: "biz-other", id: `x-${o.id}` })),
      reserveFloor: [],
    };
    const both: PlanInputsInput = {
      ...a,
      balances: [...a.balances, ...rich.balances],
      held: [...a.held, ...rich.held],
      obligations: [...a.obligations, ...rich.obligations],
      reserveFloor: [...a.reserveFloor, ...rich.reserveFloor],
    };
    expect(strip(plan(both))).toEqual(strip(plan(a)));
    const other = plan({ ...both, businessId: "biz-other" });
    expect(other.business_id).toBe("biz-other");
    expect(
      other.actions.every((x) =>
        x.params && "obligation_id" in x.params ? x.params.obligation_id.startsWith("x-") : true,
      ),
    ).toBe(true);
    expect(other.actions.some((x) => x.kind === "convert")).toBe(false);
  });

  it("the planner folder reads no clock, no randomness, no environment and makes no network call", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const path = join(dir, f);
      expect(statSync(path).isFile()).toBe(true);
      const text = readFileSync(path, "utf8");
      expect(text, f).not.toMatch(/Date\.now|Math\.random|process\.env|fetch\(|new Date\(\)/);
      expect(text, f).not.toMatch(/from\s+["'](node:|pg|drizzle|next|react)/);
    }
  });
});
