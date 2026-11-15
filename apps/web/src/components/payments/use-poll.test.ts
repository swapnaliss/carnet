import { describe, expect, it } from "vitest";
import { share } from "./use-poll";

// Structural sharing for the 3 s poll (M4-07, INP): unchanged parts keep their identity.
describe("share", () => {
  const prev = {
    server_time: "2026-11-15T10:00:00.000Z",
    rfi: { id: "r1", state: "DRAFT_READY" },
    questions: [
      { id: "q1", text: "a" },
      { id: "q2", text: "b" },
    ],
  };

  it("returns the previous object when nothing changed", () => {
    expect(share(prev, structuredClone(prev))).toBe(prev);
  });

  it("keeps unchanged branches and replaces only what changed", () => {
    const next = structuredClone(prev);
    next.server_time = "2026-11-15T10:00:03.000Z";
    next.questions[1] = { id: "q2", text: "edited" };
    const out = share(prev, next);
    expect(out).not.toBe(prev);
    expect(out).toEqual(next);
    expect(out.rfi).toBe(prev.rfi);
    expect(out.questions[0]).toBe(prev.questions[0]);
    expect(out.questions[1]).not.toBe(prev.questions[1]);
  });

  it("handles added and removed keys, array length changes and null", () => {
    expect(share({ a: 1 }, { a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(share({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 });
    expect(share([1, 2], [1])).toEqual([1]);
    expect(share({ a: null }, { a: { x: 1 } })).toEqual({ a: { x: 1 } });
    expect(share<unknown>({ a: [1] }, { a: { 0: 1 } })).toEqual({ a: { 0: 1 } });
  });
});
