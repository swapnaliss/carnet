// M2-04 AC 3 (pure part): duplicate, stale and permuted deliveries of one RFI's snapshots end in the
// same state and round as in-order delivery, which is also what the newest snapshot alone produces.
import { describe, expect, it } from "vitest";
import {
  type AirwallexRfiStatus,
  compareRfiVersion,
  planRfiIngest,
  type RfiSnapshot,
  type StoredRfiState,
  snapshotRound,
} from "../src/index";
import { prng, RUNS } from "./prng";

function fold(stored: StoredRfiState | null, snap: RfiSnapshot): StoredRfiState | null {
  const plan = planRfiIngest(stored, snap);
  if (plan.outcome === "stale" || plan.outcome === "duplicate") return stored;
  if (plan.outcome === "terminal") return stored ? { ...stored, version: snap } : stored;
  // Each step must start where the previous one ended.
  let cur = stored?.state ?? "ACTION_REQUIRED";
  for (const s of plan.steps) {
    expect(s.from).toBe(cur);
    cur = s.to;
  }
  expect(cur).toBe(plan.finalState);
  return { state: plan.finalState, round: plan.round, version: snap };
}

/** A plausible history: rounds of (ACTION_REQUIRED, ANSWERED), optionally ending CLOSED. */
function history(r: ReturnType<typeof prng>): RfiSnapshot[] {
  const out: RfiSnapshot[] = [];
  let t = Date.parse("2026-11-03T09:57:40Z");
  let answered = 0;
  const push = (status: AirwallexRfiStatus, hasAnswers: boolean) => {
    t += r.int(0, 1) * 1000; // same-second snapshots happen (rfi-followup-*)
    out.push({
      status,
      updatedAt: new Date(t),
      answeredRequests: answered,
      newestAnsweredHasAnswers: hasAnswers,
    });
  };
  const rounds = r.int(1, 3);
  for (let i = 0; i < rounds; i++) {
    push("ACTION_REQUIRED", answered > 0);
    if (i === rounds - 1 && r.int(0, 2) === 0) {
      answered += 1; // closed unanswered: the request moves to answered_requests without answers
      push("CLOSED", false);
      return out;
    }
    answered += 1;
    push("ANSWERED", true);
  }
  if (r.int(0, 1) === 0) push("CLOSED", true);
  return out;
}

describe("planRfiIngest: order independence", () => {
  it(`${RUNS} random histories, shuffled with duplicates, converge`, () => {
    const r = prng(2704);
    for (let run = 0; run < RUNS; run++) {
      const h = history(r);
      const inOrder = h.reduce<StoredRfiState | null>(fold, null);
      const newest = [...h].sort((a, b) => compareRfiVersion(a, b)).at(-1);
      if (!newest) throw new Error("empty history");
      const alone = fold(null, newest);
      const deliveries = [...h, ...h.filter(() => r.int(0, 2) === 0)];
      for (let i = deliveries.length - 1; i > 0; i--) {
        const j = r.int(0, i);
        [deliveries[i], deliveries[j]] = [
          deliveries[j] as RfiSnapshot,
          deliveries[i] as RfiSnapshot,
        ];
      }
      const shuffled = deliveries.reduce<StoredRfiState | null>(fold, null);
      const pick = (s: StoredRfiState | null) => ({ state: s?.state, round: s?.round });
      expect(pick(shuffled), `run ${run}`).toEqual(pick(inOrder));
      expect(pick(alone), `run ${run}`).toEqual(pick(inOrder));
      expect(inOrder?.round).toBe(snapshotRound(newest));
    }
  });
});

describe("planRfiIngest: recorded cases", () => {
  const v = (status: AirwallexRfiStatus, iso: string, answeredRequests: number, has = false) => ({
    status,
    updatedAt: new Date(iso),
    answeredRequests,
    newestAnsweredHasAnswers: has,
  });

  it("a new ACTION_REQUIRED RFI is created and moves to DRAFTING, enqueueing the draft", () => {
    const plan = planRfiIngest(null, v("ACTION_REQUIRED", "2026-11-03T09:57:38Z", 0));
    expect(plan).toMatchObject({
      outcome: "apply",
      create: true,
      round: 1,
      finalState: "DRAFTING",
    });
    if (plan.outcome !== "apply") throw new Error("expected apply");
    expect(plan.steps.map((s) => s.enqueueDraft)).toEqual([true]);
  });

  it("follow-up (same updated_at second as the answer): ANSWERED r1 -> REOPENED -> DRAFTING r2", () => {
    const stored: StoredRfiState = {
      state: "ANSWERED",
      round: 1,
      version: v("ANSWERED", "2026-11-03T09:57:43Z", 1, true),
    };
    const plan = planRfiIngest(stored, v("ACTION_REQUIRED", "2026-11-03T09:57:44Z", 1, true));
    expect(plan).toMatchObject({ outcome: "apply", round: 2, finalState: "DRAFTING" });
    if (plan.outcome !== "apply") throw new Error("expected apply");
    expect(plan.steps.map((s) => `${s.from}->${s.to}`)).toEqual([
      "ANSWERED->REOPENED",
      "REOPENED->DRAFTING",
    ]);
    // The answer to round 2 carries the same second; it is still newer (two answered requests).
    const after = planRfiIngest(
      {
        state: "DRAFTING",
        round: 2,
        version: v("ACTION_REQUIRED", "2026-11-03T09:57:44Z", 1, true),
      },
      v("ANSWERED", "2026-11-03T09:57:44Z", 2, true),
    );
    expect(after).toMatchObject({ outcome: "apply", finalState: "ANSWERED", round: 2 });
  });

  for (const state of ["APPROVED", "ANSWER_SUBMITTING"] as const) {
    it(`CLOSED without answers while ${state} -> EXPIRED (rfi-check5-fetch-after-close)`, () => {
      const plan = planRfiIngest(
        { state, round: 1, version: v("ACTION_REQUIRED", "2026-11-03T09:58:00Z", 0) },
        v("CLOSED", "2026-11-03T09:58:09Z", 1, false),
      );
      expect(plan).toMatchObject({ outcome: "apply", finalState: "EXPIRED" });
    });
  }

  it("stale and duplicate snapshots are dropped; terminal RFIs never move", () => {
    const stored: StoredRfiState = {
      state: "DRAFTING",
      round: 1,
      version: v("ACTION_REQUIRED", "2026-11-03T09:57:44Z", 0),
    };
    expect(planRfiIngest(stored, v("ACTION_REQUIRED", "2026-11-03T09:57:43Z", 0))).toEqual({
      outcome: "stale",
    });
    expect(planRfiIngest(stored, stored.version as RfiSnapshot)).toEqual({ outcome: "duplicate" });
    expect(
      planRfiIngest(
        { state: "EXPIRED", round: 1, version: v("CLOSED", "2026-11-03T09:58:09Z", 1) },
        v("CLOSED", "2026-11-03T09:59:00Z", 1),
      ),
    ).toEqual({ outcome: "terminal" });
  });
});
