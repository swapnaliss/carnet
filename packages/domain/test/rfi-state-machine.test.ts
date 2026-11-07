// M2-04 AC 9: every edge in the transition table has a test, and every pair not in the table throws a
// typed error.
import { describe, expect, it } from "vitest";
import {
  canTransitionRfi,
  IllegalRfiTransitionError,
  RFI_EVENTS,
  RFI_STATES,
  RFI_TRANSITIONS,
  type RfiState,
  rfiHolds,
  rfiIsOpen,
  transitionRfi,
} from "../src/index";

const key = (from: RfiState, to: RfiState) => `${from}->${to}`;

// The table written out by hand, so a change to RFI_TRANSITIONS must also change this test.
const EXPECTED: Record<string, string> = {
  "ACTION_REQUIRED->DRAFTING": "rfi.drafting_started",
  "DRAFTING->DRAFT_READY": "draft.ready",
  "DRAFTING->NEEDS_OWNER": "draft.needs_owner",
  "DRAFT_READY->APPROVED": "approval.granted",
  "NEEDS_OWNER->APPROVED": "approval.granted",
  "APPROVED->ANSWER_SUBMITTING": "answer.submitting",
  "ANSWER_SUBMITTING->ANSWERED": "airwallex.rfi.answered",
  "ANSWERED->CLOSED": "airwallex.rfi.closed",
  "ANSWERED->REOPENED": "airwallex.rfi.reopened",
  "REOPENED->DRAFTING": "rfi.drafting_started",
  "ACTION_REQUIRED->ANSWERED": "airwallex.rfi.answered_externally",
  "DRAFTING->ANSWERED": "airwallex.rfi.answered_externally",
  "DRAFT_READY->ANSWERED": "airwallex.rfi.answered_externally",
  "NEEDS_OWNER->ANSWERED": "airwallex.rfi.answered_externally",
  "APPROVED->ANSWERED": "airwallex.rfi.answered_externally",
  "REOPENED->ANSWERED": "airwallex.rfi.answered_externally",
  "ACTION_REQUIRED->EXPIRED": "airwallex.rfi.expired",
  "DRAFTING->EXPIRED": "airwallex.rfi.expired",
  "DRAFT_READY->EXPIRED": "airwallex.rfi.expired",
  "NEEDS_OWNER->EXPIRED": "airwallex.rfi.expired",
  "APPROVED->EXPIRED": "airwallex.rfi.expired",
  "ANSWER_SUBMITTING->EXPIRED": "airwallex.rfi.expired",
  "REOPENED->EXPIRED": "airwallex.rfi.expired",
};

describe("RFI transition table", () => {
  it("has exactly the expected edges, each once", () => {
    const keys = RFI_TRANSITIONS.map((t) => key(t.from, t.to));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [edge, event] of Object.entries(EXPECTED)) {
    it(`edge ${edge} is legal and emits ${event}`, () => {
      const [from, to] = edge.split("->") as [RfiState, RfiState];
      const t = transitionRfi(from, to);
      expect(t.event).toBe(event);
      expect(RFI_EVENTS).toContain(t.event);
      expect(t.enqueueDraft).toBe(to === "DRAFTING");
      expect(t.newRound).toBe(from === "REOPENED" && to === "DRAFTING");
    });
  }

  const illegal = RFI_STATES.flatMap((from) =>
    RFI_STATES.filter((to) => !(key(from, to) in EXPECTED)).map((to) => [from, to] as const),
  );

  it("covers every other ordered pair as illegal", () => {
    expect(illegal.length + Object.keys(EXPECTED).length).toBe(RFI_STATES.length ** 2);
  });

  it.each(illegal)("%s -> %s throws IllegalRfiTransitionError", (from, to) => {
    expect(canTransitionRfi(from, to)).toBe(false);
    let caught: unknown;
    try {
      transitionRfi(from, to);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IllegalRfiTransitionError);
    expect(caught).toMatchObject({ code: "ILLEGAL_RFI_TRANSITION", from, to });
  });

  it("terminal states have no way out; holding covers ACTION_REQUIRED..ANSWER_SUBMITTING and REOPENED", () => {
    for (const s of ["CLOSED", "EXPIRED"] as const) {
      expect(RFI_TRANSITIONS.filter((t) => t.from === s)).toEqual([]);
      expect(rfiIsOpen(s)).toBe(false);
    }
    expect(RFI_STATES.filter(rfiHolds)).toEqual([
      "ACTION_REQUIRED",
      "DRAFTING",
      "DRAFT_READY",
      "NEEDS_OWNER",
      "APPROVED",
      "ANSWER_SUBMITTING",
      "REOPENED",
    ]);
    expect(rfiIsOpen("ANSWERED")).toBe(true);
    expect(rfiHolds("ANSWERED")).toBe(false);
  });
});
