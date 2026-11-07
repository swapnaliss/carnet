// M2-04 AC 2 (pure part): matching table. Source shapes are the recorded ones (M0-04): TRANSFER and
// the simulator's synthetic DEPOSIT `SIMULATION_<uuid>`.
import { describe, expect, it } from "vitest";
import { matchRfiToPayment, RFI_ORPHAN_REASONS, rfiSourceKey } from "../src/index";

const A = "d48432dd-e172-4c0c-9002-6ea0e1898291"; // rfi-check7 transfer A
const B = "f5bf13df-e735-4306-8e52-f45ffd615eb6"; // rfi-check7 transfer B
const DEP = "SIMULATION_526af406-cf11-4d71-94d0-ea87a6dccec4"; // rfi-check7-fetch-no-sources
const payments: Record<string, string> = { [A]: "pay-a", [B]: "pay-b" };
const lookup = (id: string) => payments[id] ?? null;
const q = (...sources: [string, string][]) => ({
  sources: sources.map(([type, id]) => ({ type, id })),
});

const CASES = [
  {
    name: "one known TRANSFER",
    qs: [q(["TRANSFER", A])],
    want: { kind: "linked", paymentId: "pay-a", transferId: A },
  },
  {
    name: "known TRANSFER on two questions",
    qs: [q(["TRANSFER", A]), q(["TRANSFER", A])],
    want: { kind: "linked", paymentId: "pay-a", transferId: A },
  },
  {
    name: "known and unknown TRANSFER",
    qs: [q(["TRANSFER", "unknown-t"]), q(["TRANSFER", B])],
    want: { kind: "linked", paymentId: "pay-b", transferId: B },
  },
  {
    name: "known TRANSFER next to a DEPOSIT",
    qs: [q(["DEPOSIT", DEP], ["TRANSFER", A])],
    want: { kind: "linked", paymentId: "pay-a", transferId: A },
  },
  { name: "no questions", qs: [], want: { kind: "orphan", reason: "NO_SOURCES" } },
  {
    name: "questions without sources",
    qs: [q(), q()],
    want: { kind: "orphan", reason: "NO_SOURCES" },
  },
  {
    name: "DEPOSIT only (simulator orphan)",
    qs: [q(["DEPOSIT", DEP])],
    want: { kind: "orphan", reason: "NON_TRANSFER_SOURCE" },
  },
  {
    name: "unknown TRANSFER",
    qs: [q(["TRANSFER", "unknown-t"])],
    want: { kind: "orphan", reason: "UNKNOWN_TRANSFER" },
  },
  {
    name: "per-question sources on two payments",
    qs: [q(["TRANSFER", A]), q(["TRANSFER", B])],
    want: { kind: "orphan", reason: "MULTIPLE_PAYMENTS" },
  },
  {
    name: "two sources on one question, two payments",
    qs: [q(["TRANSFER", A], ["TRANSFER", B])],
    want: { kind: "orphan", reason: "MULTIPLE_PAYMENTS" },
  },
] as const;

describe("matchRfiToPayment", () => {
  it.each(CASES)("$name", ({ qs, want }) => {
    expect(matchRfiToPayment(qs, lookup)).toEqual(want);
  });

  it("the orphan reasons are distinct codes", () => {
    expect(new Set(RFI_ORPHAN_REASONS).size).toBe(RFI_ORPHAN_REASONS.length);
  });

  it("another business's transfer is unknown (the lookup is per business)", () => {
    expect(matchRfiToPayment([q(["TRANSFER", A])], () => null)).toEqual({
      kind: "orphan",
      reason: "UNKNOWN_TRANSFER",
    });
  });
});

describe("rfiSourceKey", () => {
  it("is order independent and de-duplicated", () => {
    expect(rfiSourceKey([q(["TRANSFER", B]), q(["TRANSFER", A], ["TRANSFER", B])])).toBe(
      `TRANSFER:${A},TRANSFER:${B}`,
    );
  });
  it("is null without sources (unguarded)", () => {
    expect(rfiSourceKey([q()])).toBeNull();
  });
});
