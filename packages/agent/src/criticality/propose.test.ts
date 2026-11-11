// Unit tests for the criticality proposal (M3-01): verifier, request payload, image-only, boundaries.
// Model answers here are scripted (hand-written), not recorded; recorded answers are in the evals.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { planningCriticality, verifyCriticalityQuote } from "@carnet/domain";
import { describe, expect, it } from "vitest";
import { assertCase } from "../../evals/criticality/assertions";
import { type CriticalityCase, runCase } from "../../evals/criticality/run";
import { readTextLayer } from "../extraction/verify-quotes";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CLAUSE =
  "5. Late payment: A late fee of 1.5% of the overdue amount is charged for each month an invoice stays unpaid.";
const base: CriticalityCase = {
  id: "unit-late-fee",
  kind: "clause",
  file: "fixtures/criticality/ct-late-fee.pdf",
  mime: "application/pdf",
  injectedMarkers: [],
  expected: 2,
  scripted: {
    criticality: "2",
    rationale: "A late fee applies and service continues.",
    quote: CLAUSE,
    page: 2,
    injection_suspected: false,
  },
};

describe("proposal with a verbatim quote", () => {
  it("is VERIFIED, stays UNCONFIRMED for the planner, and sends no tool or credential", async () => {
    const run = await runCase(base, "replay");
    expect(run.result.verifierResult).toBe("VERIFIED");
    expect(planningCriticality(run.obligation)).toBe("UNCONFIRMED");
    await assertCase(run);
    expect(run.requestBodies.length).toBe(1);
  });
});

describe("verifier", () => {
  it("rejects a mutated quote: an altered word, another page, an invented clause", async () => {
    const layer = await readTextLayer(new Uint8Array(readFileSync(join(ROOT, base.file))));
    const pages = layer?.pages ?? [];
    expect(verifyCriticalityQuote(CLAUSE, 2, pages).ok).toBe(true);
    const altered = verifyCriticalityQuote(CLAUSE.replace("late fee", "late penalty"), 2, pages);
    expect(altered).toEqual({ ok: false, reason: "quote_not_found" });
    expect(verifyCriticalityQuote(CLAUSE, 1, pages)).toEqual({
      ok: false,
      reason: "quote_not_found",
    });
    expect(verifyCriticalityQuote(CLAUSE, 9, pages)).toEqual({
      ok: false,
      reason: "page_out_of_range",
    });
    expect(
      verifyCriticalityQuote("Supplier may terminate this agreement at once.", 2, pages),
    ).toEqual({ ok: false, reason: "quote_not_found" });
  });

  it("rejects a verbatim quote that is not about late-payment consequences", async () => {
    const layer = await readTextLayer(new Uint8Array(readFileSync(join(ROOT, base.file))));
    const verdict = verifyCriticalityQuote(
      "4. Payment: Buyer pays each invoice within 30 days of the invoice date.",
      2,
      layer?.pages ?? [],
    );
    expect(verdict).toEqual({ ok: false, reason: "no_payment_clause" });
  });

  it("a fabricated quote from the model becomes REJECTED", async () => {
    const run = await runCase(
      {
        ...base,
        id: "unit-fabricated",
        scripted: {
          ...(base.scripted as NonNullable<typeof base.scripted>),
          quote: "Supplier may terminate at once.",
          criticality: "1",
        },
      },
      "replay",
    );
    expect(run.result.verifierResult).toBe("REJECTED");
  });
});

describe("image-only contract", () => {
  it("gets no model call and no proposal value", async () => {
    const run = await runCase(
      {
        id: "unit-scan",
        kind: "image-only",
        file: "fixtures/dataset/inv-nordlicht-scan-001.pdf",
        mime: "application/pdf",
        injectedMarkers: [],
        scripted: base.scripted as NonNullable<typeof base.scripted>,
      },
      "replay",
    );
    expect(run.result.verifierResult).toBe("REJECTED");
    expect(run.requestBodies).toHaveLength(0);
  });
});

describe("boundary: the agent cannot confirm a criticality", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) ? [p] : [];
    });
  it("no agent source imports the db package or names the confirm path", () => {
    for (const f of files(join(ROOT, "packages/agent/src")).filter(
      (x) => !x.endsWith(".test.ts"),
    )) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/confirmCriticality|obligation-confirm|criticality_confirmed/);
      expect(text, f).not.toMatch(/from "@carnet\/db"/);
    }
  });
});
