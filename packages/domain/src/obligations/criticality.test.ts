import { describe, expect, it } from "vitest";
import {
  CRITICALITY_PROPOSAL_STATUSES,
  concernsLatePaymentConsequence,
  planningCriticality,
} from "./criticality";

describe("planningCriticality", () => {
  it("is the confirmed value", () => {
    expect(planningCriticality({ criticality: 2, criticalityConfirmedBy: "u1" })).toBe(2);
  });
  it("is UNCONFIRMED without a value or without a confirming user", () => {
    expect(planningCriticality({ criticality: null, criticalityConfirmedBy: null })).toBe(
      "UNCONFIRMED",
    );
    expect(planningCriticality({ criticality: 1, criticalityConfirmedBy: null })).toBe(
      "UNCONFIRMED",
    );
    expect(planningCriticality({ criticality: 7, criticalityConfirmedBy: "u1" })).toBe(
      "UNCONFIRMED",
    );
  });
});

describe("concernsLatePaymentConsequence", () => {
  it.each([
    "a late fee of 2%",
    "bears interest",
    "may suspend services",
    "Termination for cause",
    "a penalty",
    "in default",
  ])("accepts %s", (q) => expect(concernsLatePaymentConsequence(q)).toBe(true));
  it("rejects plain payment terms", () => {
    expect(concernsLatePaymentConsequence("Buyer pays each invoice within 30 days")).toBe(false);
  });
});

describe("statuses", () => {
  it("lists the four proposal states", () => {
    expect([...CRITICALITY_PROPOSAL_STATUSES]).toEqual([
      "PROPOSED",
      "CONFIRMED",
      "OVERRIDDEN",
      "REJECTED",
    ]);
  });
});
