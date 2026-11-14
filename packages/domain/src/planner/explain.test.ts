import { describe, expect, it } from "vitest";
import { payrollFriday, withoutHold } from "../../test/planner-support";
import {
  extractClaims,
  groupMinor,
  planFacts,
  renderExplanation,
  verifyExplanation,
} from "./explain";
import { type Plan, plan } from "./index";

const held = (): Plan => plan(payrollFriday());
const calm = (): Plan => plan(withoutHold(payrollFriday()));

describe("renderExplanation", () => {
  it("says what the plan does, in amounts taken from the plan", () => {
    const text = renderExplanation(held());
    expect(text).toContain("Payroll (team): EUR 4,000.00 is funded by converting USD ");
    expect(text).toContain("at 0.8847");
    expect(text).toContain(
      "Nordlicht Print GmbH: the held payment is replaced by an alternate payout of EUR 2,500.00",
    );
    expect(text).toContain("Hosting bill: EUR 2,500.00 is deferred from 2026-11-");
    expect(text).toContain("The SWIFT fee of EUR 13.41 is added.");
  });

  it("is deterministic and verifies against its own plan, for held and unheld plans", () => {
    for (const p of [held(), calm()]) {
      const text = renderExplanation(p);
      expect(renderExplanation(p)).toBe(text);
      expect(verifyExplanation(text, p)).toEqual({ ok: true });
    }
  });
});

describe("verifyExplanation", () => {
  it("rejects a text about another plan", () => {
    expect(verifyExplanation(renderExplanation(calm()), held()).ok).toBe(false);
  });

  it("rejects an invented amount, currency, number and date", () => {
    const p = held();
    const text = renderExplanation(p);
    expect(verifyExplanation(`${text} Also EUR 1.00 moves.`, p).ok).toBe(false);
    expect(verifyExplanation(`${text} Also JPY 5,000 moves.`, p).ok).toBe(false);
    expect(verifyExplanation(`${text} It is 7 days late.`, p).ok).toBe(false);
    expect(verifyExplanation(`${text} Due 2031-01-01.`, p).ok).toBe(false);
  });

  it("does not read digits inside a payee name as a claim", () => {
    expect(
      extractClaims("Unit 9 Supplier 77 Ltd: EUR 2,500.00", ["Unit 9 Supplier 77 Ltd"]),
    ).toMatchObject({ amounts: ["EUR 2,500.00"], numbers: [] });
    expect(planFacts(held()).names).toContain("Hosting bill");
  });

  it("property: changing any one digit of the rendered text is rejected", () => {
    for (const p of [held(), calm()]) {
      const text = renderExplanation(p);
      const facts = planFacts(p);
      const nameSpans: Array<[number, number]> = [];
      for (const name of facts.names) {
        for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) {
          nameSpans.push([i, i + name.length]);
        }
      }
      let mutations = 0;
      let collisions = 0;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i] as string;
        if (!/\d/.test(ch) || nameSpans.some(([a, b]) => i >= a && i < b)) continue;
        for (const d of "0123456789") {
          if (d === ch) continue;
          const mutated = `${text.slice(0, i)}${d}${text.slice(i + 1)}`;
          mutations += 1;
          // A change that lands on another real figure of the plan (a day that is also another due
          // date) is a coincidence, not a made-up number; it must stay rare.
          if (verifyExplanation(mutated, p).ok) collisions += 1;
        }
      }
      expect(mutations).toBeGreaterThan(100);
      expect(collisions / mutations).toBeLessThan(0.05);
    }
  });

  it("property: every digit of the text sits inside a checked claim", () => {
    const p = held();
    const text = renderExplanation(p);
    const facts = planFacts(p);
    const c = extractClaims(text, facts.names);
    const digitsIn = (s: string) => (s.match(/\d/g) ?? []).length;
    const claimed = [...c.amounts, ...c.numbers, ...c.dates].reduce((n, s) => n + digitsIn(s), 0);
    let stripped = text;
    for (const name of facts.names) stripped = stripped.split(name).join("");
    expect(claimed).toBe(digitsIn(stripped));
  });
});

describe("groupMinor", () => {
  it("groups exactly, for 0 and 2 decimal currencies", () => {
    expect(groupMinor(420000n, "EUR")).toBe("4,200.00");
    expect(groupMinor(5n, "USD")).toBe("0.05");
    expect(groupMinor(-1234567n, "USD")).toBe("-12,345.67");
    expect(groupMinor(1234567n, "JPY")).toBe("1,234,567");
    expect(groupMinor(9007199254740993n, "USD")).toBe("90,071,992,547,409.93");
  });
});
