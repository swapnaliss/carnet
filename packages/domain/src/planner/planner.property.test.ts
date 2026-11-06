// Property tests (M3-02): each runs RUNS (1,000) generated cases from a fixed seed, so CI is
// reproducible; a failure names the seed and the case index. The generator is the hand-rolled
// mulberry32 from M0-02 (no dependency).
import { describe, expect, it, vi } from "vitest";

// 1,000 cases per property; the workspace run uses vitest's 5 s default, too short under load.
vi.setConfig({ testTimeout: 120_000 });

import { prng, RUNS } from "../../test/prng";
import type { Currency } from "../money";
import {
  canonicalJson,
  nextRevision,
  type Plan,
  type PlanInputsInput,
  parsePlan,
  plan,
} from "./index";

type Rng = ReturnType<typeof prng>;
const CURRENCIES: readonly Currency[] = ["USD", "EUR", "GBP", "JPY"];
const NOW = Date.UTC(2026, 10, 4, 9, 0, 0);
const DAY = 86_400_000;

function generate(r: Rng): PlanInputsInput {
  const biz = "b1";
  const other = "b2";
  const rows = <T>(business: string, make: (c: Currency) => T | null) =>
    CURRENCIES.flatMap((c) => {
      const row = make(c);
      return row === null ? [] : [{ ...row, businessId: business }];
    });
  const balances = [biz, other].flatMap((b) =>
    rows(b, (currency) =>
      r.int(0, 9) < 8 ? { currency, availableMinor: BigInt(r.int(0, 2_000_000)) } : null,
    ),
  );
  const reserveFloor = [biz, other].flatMap((b) =>
    rows(b, (currency) =>
      r.int(0, 1) === 0 ? { currency, minor: BigInt(r.int(0, 300_000)) } : null,
    ),
  );
  const held: NonNullable<PlanInputsInput["held"]> = [];
  const obligations: NonNullable<PlanInputsInput["obligations"]> = [];
  for (const b of [biz, other]) {
    const n = r.int(0, b === biz ? 6 : 3);
    for (let i = 0; i < n; i++) {
      const id = `${b}-ob-${i}`;
      const currency = r.pick(CURRENCIES);
      const paymentId = r.int(0, 9) < 3 ? `${b}-pay-${i}` : null;
      if (paymentId !== null && r.int(0, 9) < 6) {
        held.push({
          businessId: b,
          paymentId,
          currency: r.pick(CURRENCIES),
          amountMinor: BigInt(r.int(1, 500_000)),
        });
      }
      obligations.push({
        businessId: b,
        id,
        payee: `payee-${i}`,
        amountMinor: BigInt(r.int(1, 800_000)),
        currency,
        dueAt: new Date(NOW + r.int(-2, 12) * DAY).toISOString(),
        criticality: r.pick([1, 2, 3, "UNCONFIRMED"] as const),
        paymentId,
        payoutMethod: r.pick(["SWIFT", "LOCAL"] as const),
      });
    }
  }
  const fxRates = CURRENCIES.flatMap((sell) =>
    CURRENCIES.filter((buy) => buy !== sell && r.int(0, 9) < 8).map((buy) => ({
      sell,
      buy,
      rate: (r.int(1, 29_999) / 10_000).toFixed(4),
      asOf: new Date(NOW - r.int(0, 3) * DAY).toISOString(),
    })),
  );
  return {
    businessId: biz,
    now: new Date(NOW).toISOString(),
    balances,
    held,
    obligations,
    reserveFloor,
    fxRates,
    config: {
      swiftPayoutFee: CURRENCIES.filter(() => r.int(0, 1) === 0).map((currency) => ({
        currency,
        minor: BigInt(r.int(0, 2_000)),
      })),
      fxSpreadBps: r.int(0, 300),
      heldFundsVisibleInBalances: r.int(0, 1) === 0,
      deferGraceDays: { "2": r.int(0, 10), "3": r.int(0, 20) },
    },
    policy: {
      version: 1,
      hash: "policy-v1",
      autoConvertLimits: CURRENCIES.filter(() => r.int(0, 1) === 0).map((currency) => ({
        currency,
        minor: BigInt(r.int(0, 1_000_000)),
      })),
    },
  };
}

function forAll(name: string, seed: number, check: (inputs: PlanInputsInput, r: Rng) => void) {
  const r = prng(seed);
  // Printed so a CI log shows the property, its case count and the fixed seed (replay with it).
  console.info(`property "${name}": ${RUNS} cases, seed ${seed}`);
  for (let i = 0; i < RUNS; i++) {
    const inputs = generate(r);
    try {
      check(inputs, r);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`property "${name}" failed: seed=${seed} case=${i}: ${message}`);
    }
  }
}

const big = (v: unknown): bigint => BigInt(v as string | bigint | number);
const balanceOf = (inputs: PlanInputsInput, c: Currency): bigint =>
  big(
    (inputs.balances ?? []).find((b) => b.businessId === inputs.businessId && b.currency === c)
      ?.availableMinor ?? 0,
  );
const heldOf = (inputs: PlanInputsInput, c: Currency): bigint =>
  (inputs.held ?? [])
    .filter((h) => h.businessId === inputs.businessId && h.currency === c)
    .reduce((sum, h) => sum + big(h.amountMinor), 0n);
const floorOf = (inputs: PlanInputsInput, c: Currency): bigint =>
  big(
    (inputs.reserveFloor ?? []).find((f) => f.businessId === inputs.businessId && f.currency === c)
      ?.minor ?? 0,
  );
const visible = (inputs: PlanInputsInput) => inputs.config?.heldFundsVisibleInBalances === true;

/** Cash after each action, in plan order: converts move cash between currencies, the rest spend it. */
function ledgers(inputs: PlanInputsInput, p: Plan): Map<Currency, bigint>[] {
  const cash = new Map<Currency, bigint>();
  for (const c of CURRENCIES)
    cash.set(c, balanceOf(inputs, c) - (visible(inputs) ? 0n : heldOf(inputs, c)));
  const steps: Map<Currency, bigint>[] = [new Map(cash)];
  for (const a of p.actions) {
    if (a.kind === "convert") {
      cash.set(
        a.params.sell_currency,
        (cash.get(a.params.sell_currency) ?? 0n) - big(a.params.sell_minor),
      );
      cash.set(
        a.params.buy_currency,
        (cash.get(a.params.buy_currency) ?? 0n) + big(a.params.buy_minor),
      );
    } else if (a.kind === "fund" || a.kind === "payout") {
      cash.set(
        a.params.currency,
        (cash.get(a.params.currency) ?? 0n) - big(a.params.reserved_minor),
      );
    }
    steps.push(new Map(cash));
  }
  return steps;
}

const funded = (p: Plan): string[] =>
  p.actions
    .flatMap((a) => (a.kind === "fund" || a.kind === "payout" ? [a.params.obligation_id] : []))
    .sort();

const shuffle = <T>(r: Rng, items: readonly T[]): T[] => {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
};

describe("planner property tests", () => {
  it("property generator reaches every action kind and the unconfirmed and floor paths", () => {
    const seen = new Set<string>();
    const r = prng(0x5eed01);
    for (let i = 0; i < RUNS; i++) {
      for (const a of plan(generate(r)).actions) {
        seen.add(a.kind);
        seen.add(a.reason_code);
      }
    }
    for (const kind of ["fund", "convert", "defer", "escalate", "payout"]) {
      expect(seen.has(kind), `no ${kind} generated`).toBe(true);
    }
    expect(seen.has("ESCALATE_UNCONFIRMED_SHORT")).toBe(true);
    expect(seen.has("FUNDED_AFTER_CONVERSION")).toBe(true);
  });

  it(`property: the reserve floor is never breached by any action sequence (${RUNS} cases)`, () => {
    forAll("reserve floor", 0x5eed01, (inputs) => {
      const p = plan(inputs);
      const steps = ledgers(inputs, p);
      for (const c of CURRENCIES) {
        const start = steps[0]?.get(c) ?? 0n;
        const floor = floorOf(inputs, c);
        const bound = start < floor ? start : floor; // a balance already under the floor may not shrink
        for (const step of steps) {
          expect(step.get(c) ?? 0n, `currency ${c}`).toBeGreaterThanOrEqual(bound);
        }
      }
    });
  });

  it(`property: balances are never summed across businesses or currencies without a convert (${RUNS} cases)`, () => {
    forAll("no mixing", 0x5eed02, (inputs) => {
      const p = plan(inputs);
      const strip = (x: Plan) => x.actions.map(({ seq: _seq, ...rest }) => rest);
      // (a) another business's rows change nothing.
      const mine = <T extends { businessId: string }>(rows: readonly T[] | undefined) =>
        (rows ?? []).filter((row) => row.businessId === inputs.businessId);
      const alone = plan({
        ...inputs,
        balances: mine(inputs.balances),
        held: mine(inputs.held),
        obligations: mine(inputs.obligations),
        reserveFloor: mine(inputs.reserveFloor),
      });
      expect(strip(p)).toEqual(strip(alone));
      // (b) with no rate between currencies there is no convert, and each currency's decisions depend
      // on that currency's rows alone.
      const noFx = plan({ ...inputs, fxRates: [] });
      expect(noFx.actions.some((a) => a.kind === "convert")).toBe(false);
      for (const c of CURRENCIES) {
        const only = plan({
          ...inputs,
          fxRates: [],
          balances: (inputs.balances ?? []).filter((b) => b.currency === c),
          // Held rows stay: a held row only subtracts from its own currency's cash, and a payment's
          // held state decides `payout` versus `fund`, which is not arithmetic across currencies.
          obligations: (inputs.obligations ?? []).filter((o) => o.currency === c),
          reserveFloor: (inputs.reserveFloor ?? []).filter((f) => f.currency === c),
        });
        const ofC = (x: Plan) =>
          strip(x).filter((a) => "currency" in a.params && a.params.currency === c);
        expect(ofC(noFx)).toEqual(ofC(only));
      }
      // (c) every plan's cash, currency by currency, balances after the conversions it contains.
      const end = ledgers(inputs, p).at(-1);
      for (const c of CURRENCIES) {
        const start = balanceOf(inputs, c) - (visible(inputs) ? 0n : heldOf(inputs, c));
        if (start >= 0n) expect(end?.get(c) ?? 0n).toBeGreaterThanOrEqual(0n);
      }
    });
  });

  it(`property: held funds are never spent (${RUNS} cases)`, () => {
    forAll("held funds unavailable", 0x5eed03, (inputs) => {
      const asCounted: PlanInputsInput = {
        ...inputs,
        config: { ...inputs.config, heldFundsVisibleInBalances: false },
      } as PlanInputsInput;
      const p = plan(asCounted);
      const end = ledgers(asCounted, p).at(-1);
      for (const c of CURRENCIES) {
        const availableAfterHold = balanceOf(inputs, c) - heldOf(inputs, c);
        const spent = availableAfterHold - (end?.get(c) ?? 0n); // net of conversions in
        // Total spent in a currency is at most available minus held (and zero when that is not positive).
        expect(spent, `currency ${c}`).toBeLessThanOrEqual(
          availableAfterHold > 0n ? availableAfterHold : 0n,
        );
      }
    });
  });

  it(`property: the plan is deterministic and independent of input order (${RUNS} cases)`, () => {
    forAll("deterministic", 0x5eed04, (inputs, r) => {
      const a = plan(inputs);
      expect(JSON.stringify(plan(inputs))).toBe(JSON.stringify(a));
      const permuted = plan({
        ...inputs,
        balances: shuffle(r, inputs.balances ?? []),
        held: shuffle(r, inputs.held ?? []),
        obligations: shuffle(r, inputs.obligations ?? []),
        reserveFloor: shuffle(r, inputs.reserveFloor ?? []),
        fxRates: shuffle(r, inputs.fxRates ?? []),
      });
      expect(JSON.stringify(permuted)).toBe(JSON.stringify(a));
    });
  });

  it(`property: more cash never turns a fund into a defer or escalate (${RUNS} cases)`, () => {
    forAll("monotone with more cash", 0x5eed05, (inputs, r) => {
      const before = plan(inputs);
      const currency = r.pick(CURRENCIES);
      const extra = BigInt(r.int(1, 3_000_000));
      const balances = (inputs.balances ?? []).filter(
        (b) => !(b.businessId === inputs.businessId && b.currency === currency),
      );
      balances.push({
        businessId: inputs.businessId,
        currency,
        availableMinor: balanceOf(inputs, currency) + extra,
      });
      const after = plan({ ...inputs, balances });
      const now = new Set(funded(after));
      for (const id of funded(before)) expect(now.has(id), `${id} lost its funding`).toBe(true);
      expect(funded(after).length).toBeGreaterThanOrEqual(funded(before).length);
    });
  });

  it(`property: the revision hash is idempotent and a changed balance is revision + 1 (${RUNS} cases)`, () => {
    forAll("revision hash", 0x5eed06, (inputs, r) => {
      const first = nextRevision(null, inputs);
      expect(nextRevision(first, inputs)).toBe(first); // the very same object
      const reordered = nextRevision(first, {
        ...inputs,
        balances: shuffle(r, inputs.balances ?? []),
      });
      expect(reordered).toBe(first);
      const currency = r.pick(CURRENCIES);
      const balances = (inputs.balances ?? []).filter(
        (b) => !(b.businessId === inputs.businessId && b.currency === currency),
      );
      balances.push({
        businessId: inputs.businessId,
        currency,
        availableMinor: balanceOf(inputs, currency) + 1n,
      });
      const second = nextRevision(first, { ...inputs, balances });
      expect(second.revision).toBe(first.revision + 1);
      expect(second.inputs_hash).not.toBe(first.inputs_hash);
    });
  });

  it(`property: a plan survives a JSON round trip unchanged (${RUNS} cases)`, () => {
    forAll("serialisation round trip", 0x5eed07, (inputs) => {
      const p = plan(inputs);
      const text = JSON.stringify(p);
      expect(parsePlan(JSON.parse(text))).toEqual(p);
      expect(canonicalJson(parsePlan(JSON.parse(text)))).toBe(canonicalJson(p));
    });
  });
});
