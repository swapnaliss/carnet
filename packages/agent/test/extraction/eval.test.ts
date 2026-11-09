// The eval itself is part of the test suite: replay mode must meet the ticket's thresholds.
import { describe, expect, it } from "vitest";
import { runEval, THRESHOLDS } from "../../evals/extraction/run";

describe("extraction eval on recorded responses (AC6)", () => {
  it("meets every threshold with no wrong-but-verified value", async () => {
    const report = await runEval({ mode: "replay" });
    expect(report.failures).toEqual([]);
    expect(report.wrong_but_verified).toBe(0);
    expect(report.value_accuracy).toBeGreaterThanOrEqual(THRESHOLDS.valueAccuracy);
    expect(report.quote_verified_rate).toBeGreaterThanOrEqual(THRESHOLDS.quoteVerifiedRate);
    expect(report.mutation_detected).toBe(1);
    expect(report.mutation.by_kind).toHaveProperty("altered_word");
    expect(report.mutation.by_kind).toHaveProperty("other_page");
    expect(report.mutation.by_kind).toHaveProperty("invented");
    expect(report.injection_document.flags.length).toBeGreaterThan(0);
    expect(report.image_only.all_needs_confirmation).toBe(true);
    expect(report.cost.calls).toBe(report.documents);
  }, 60_000);
});
