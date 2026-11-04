import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyTransferUpdate,
  assertNever,
  isTransferStatus,
  type PaymentProjection,
  project,
  rank,
  TRANSFER_STATUSES,
  type TransferSnapshot,
  type TransferStatus,
  type TransferUpdateResult,
} from "../src/index";
import { prng, RUNS } from "./prng";

// Adding a status to the union breaks this record (missing key) and the switch in project()
// (assertNever receives a non-never value), so both fail type-checking.
const EXPECTED: Record<TransferStatus, { none: PaymentProjection; rfi: PaymentProjection }> = {
  IN_APPROVAL: {
    none: { view: "AWAITING_APPROVAL", held: false, final: false },
    rfi: { view: "AWAITING_APPROVAL", held: false, final: false },
  },
  APPROVAL_RECALLED: {
    none: { view: "NOT_SENT", held: false, final: true },
    rfi: { view: "NOT_SENT", held: false, final: true },
  },
  APPROVAL_REJECTED: {
    none: { view: "NOT_SENT", held: false, final: true },
    rfi: { view: "NOT_SENT", held: false, final: true },
  },
  APPROVAL_BLOCKED: {
    none: { view: "NOT_SENT", held: false, final: true },
    rfi: { view: "NOT_SENT", held: false, final: true },
  },
  SCHEDULED: {
    none: { view: "SCHEDULED", held: false, final: false },
    rfi: { view: "SCHEDULED", held: true, final: false },
  },
  OVERDUE: {
    none: { view: "OVERDUE", held: false, final: false },
    rfi: { view: "OVERDUE", held: false, final: false },
  },
  PROCESSING: {
    none: { view: "PROCESSING", held: false, final: false },
    rfi: { view: "PROCESSING", held: true, final: false },
  },
  SENT: {
    none: { view: "SENT", held: false, final: false },
    rfi: { view: "SENT", held: true, final: false },
  },
  PAID: {
    none: { view: "PAID", held: false, final: false },
    rfi: { view: "PAID", held: false, final: false },
  },
  FAILED: {
    none: { view: "FAILED", held: false, final: true },
    rfi: { view: "FAILED", held: false, final: true },
  },
  CANCELLED: {
    none: { view: "FAILED", held: false, final: true },
    rfi: { view: "FAILED", held: false, final: true },
  },
};

describe("project() is total", () => {
  it("has exactly the eleven Airwallex statuses", () => {
    expect(TRANSFER_STATUSES).toHaveLength(11);
    expect(new Set(TRANSFER_STATUSES).size).toBe(11);
    expect(Object.keys(EXPECTED).sort()).toEqual([...TRANSFER_STATUSES].sort());
  });

  const cases = TRANSFER_STATUSES.flatMap((s) => [
    [s, false],
    [s, true],
  ]) as [TransferStatus, boolean][];

  it("enumerates 22 cases", () => expect(cases).toHaveLength(22));

  it.each(cases)("project(%s, openRfi=%s) is defined and matches the table", (s, openRfi) => {
    const p = project(s, openRfi);
    expect(p).toBeDefined();
    expect(p).toEqual(EXPECTED[s][openRfi ? "rfi" : "none"]);
  });

  it("the exhaustiveness guard rejects values outside the union", () => {
    // @ts-expect-error a status outside the union is not assignable to never
    expect(() => assertNever("NEW_STATUS")).toThrow();
  });

  it("isTransferStatus accepts exactly the eleven statuses", () => {
    for (const s of TRANSFER_STATUSES) expect(isTransferStatus(s)).toBe(true);
    for (const s of ["", "paid", "SETTLED", "FUNDED", "ACTION_REQUIRED", "CLOSED"]) {
      expect(isTransferStatus(s)).toBe(false);
    }
  });
});

describe("an RFI never changes the money status", () => {
  it("an open RFI never produces SENT, PAID or FAILED, and never changes the view", () => {
    for (const s of TRANSFER_STATUSES) {
      const without = project(s, false);
      const withRfi = project(s, true);
      expect(withRfi.view).toBe(without.view);
      expect(withRfi.final).toBe(without.final);
      if (!["SENT", "PAID", "FAILED"].includes(without.view)) {
        expect(["SENT", "PAID", "FAILED"]).not.toContain(withRfi.view);
      }
    }
  });

  it("held is true only with an open RFI on SCHEDULED, PROCESSING or SENT", () => {
    const heldStatuses = new Set<TransferStatus>(["SCHEDULED", "PROCESSING", "SENT"]);
    for (const s of TRANSFER_STATUSES) {
      expect(project(s, false).held).toBe(false);
      expect(project(s, true).held).toBe(heldStatuses.has(s));
    }
  });
});

// ---- applyTransferUpdate -------------------------------------------------------------------

interface Ev extends TransferSnapshot {
  readonly seq: number;
}

const T0 = Date.parse("2026-11-04T06:00:00Z");
const ev = (status: TransferStatus, second: number, seq = 0): Ev => ({
  status,
  updatedAt: new Date(T0 + second * 1000),
  seq,
});

function fold(events: readonly Ev[]): Ev | null {
  let state: Ev | null = null;
  for (const e of events) {
    const before: Ev | null = state;
    state = applyTransferUpdate(state, e).state;
    if (before !== null) {
      // a stale event never overwrites a newer one
      expect(state.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
      expect(rank(state.status)).toBeGreaterThanOrEqual(rank(before.status));
    }
  }
  return state;
}

function* permutations<T>(items: readonly T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) yield [items[i] as T, ...p];
  }
}

const SEQUENCES: Record<string, readonly Ev[]> = {
  "paid then failed": [
    ev("IN_APPROVAL", 0, 1),
    ev("SCHEDULED", 1, 2),
    ev("PROCESSING", 2, 3),
    ev("SENT", 3, 4),
    ev("PAID", 4, 5),
    ev("FAILED", 5, 6),
  ],
  "overdue then paid": [
    ev("IN_APPROVAL", 0, 1),
    ev("SCHEDULED", 1, 2),
    ev("OVERDUE", 2, 3),
    ev("PROCESSING", 3, 4),
    ev("SENT", 4, 5),
    ev("PAID", 5, 6),
  ],
};

describe("applyTransferUpdate over permuted event orders", () => {
  for (const [name, seq] of Object.entries(SEQUENCES)) {
    const inOrder = fold(seq);

    it(`${name}: all 720 permutations end in the in-order state`, () => {
      let count = 0;
      for (const p of permutations(seq)) {
        expect(fold(p)).toEqual(inOrder);
        count++;
      }
      expect(count).toBe(720);
    });

    it(`${name}: 1,000 random shuffles with duplicates end in the in-order state`, () => {
      const r = prng(name.length * 7919);
      for (let i = 0; i < RUNS; i++) {
        const events = [...seq];
        const dups = r.int(0, 6);
        for (let d = 0; d < dups; d++) events.push(r.pick(seq));
        for (let k = events.length - 1; k > 0; k--) {
          const j = r.int(0, k);
          [events[k], events[j]] = [events[j] as Ev, events[k] as Ev];
        }
        expect(fold(events)).toEqual(inOrder);
      }
    });
  }

  it("duplicate application is idempotent", () => {
    for (const e of SEQUENCES["paid then failed"] ?? []) {
      const once = applyTransferUpdate(null, e).state;
      const twice = applyTransferUpdate(once, e);
      expect(twice).toEqual({ outcome: "ignored", state: once, reason: "duplicate" });
    }
  });

  it("an older updated_at is ignored even with a higher rank", () => {
    const r = applyTransferUpdate(ev("SCHEDULED", 5), ev("PAID", 4));
    expect(r).toMatchObject({ outcome: "ignored", reason: "older_updated_at" });
    expect(r.state.status).toBe("SCHEDULED");
  });

  it("a lower rank is ignored even with a newer updated_at", () => {
    const r = applyTransferUpdate(ev("SENT", 1), ev("PROCESSING", 2));
    expect(r).toMatchObject({ outcome: "ignored", reason: "lower_rank" });
  });

  it("equal updated_at resolves by rank", () => {
    expect(applyTransferUpdate(ev("SENT", 1), ev("PAID", 1)).state.status).toBe("PAID");
    expect(applyTransferUpdate(ev("PAID", 1), ev("SENT", 1)).state.status).toBe("PAID");
    expect(applyTransferUpdate(ev("FAILED", 1), ev("CANCELLED", 1)).state.status).toBe("CANCELLED");
  });

  it("a newer snapshot in the same status is applied (carries fresh fields)", () => {
    const r = applyTransferUpdate(ev("PROCESSING", 1, 1), ev("PROCESSING", 2, 2));
    expect(r).toMatchObject({ outcome: "applied", incident: null });
    expect(r.state.seq).toBe(2);
  });
});

describe("PAID then FAILED", () => {
  it("PAID followed by FAILED returns an incident marker", () => {
    const r = applyTransferUpdate(ev("PAID", 1), ev("FAILED", 2));
    expect(r.outcome).toBe("applied");
    expect(r.state.status).toBe("FAILED");
    expect(r.outcome === "applied" && r.incident).toEqual({
      kind: "PAID_THEN_FAILED",
      from: "PAID",
      to: "FAILED",
      at: new Date(T0 + 2000),
    });
  });

  it("PAID followed by CANCELLED (a failed transfer ends CANCELLED) is also an incident", () => {
    const r = applyTransferUpdate(ev("PAID", 1), ev("CANCELLED", 1));
    expect(r.outcome === "applied" && r.incident?.to).toBe("CANCELLED");
  });

  it("FAILED followed by an older PAID is ignored", () => {
    const r = applyTransferUpdate(ev("FAILED", 2), ev("PAID", 1));
    expect(r).toMatchObject({ outcome: "ignored", reason: "older_updated_at" });
    expect(r.state.status).toBe("FAILED");
  });

  it("no other transition raises an incident", () => {
    for (const from of TRANSFER_STATUSES) {
      for (const to of TRANSFER_STATUSES) {
        const r = applyTransferUpdate(ev(from, 1), ev(to, 2));
        const expected = from === "PAID" && (to === "FAILED" || to === "CANCELLED");
        expect(r.outcome === "applied" && r.incident !== null, `${from} -> ${to}`).toBe(expected);
      }
    }
  });
});

// ---- replay of recorded Airwallex data (M0-03, M0-05) --------------------------------------

const FIXTURES = new URL("../../../fixtures/airwallex/", import.meta.url);

interface Wire {
  id: string;
  status: string;
  updated_at: string;
}

function snapshot(w: Wire): TransferSnapshot & { id: string } {
  if (!isTransferStatus(w.status)) throw new Error(`unexpected status ${w.status}`);
  const ms = Date.parse(w.updated_at);
  if (Number.isNaN(ms)) throw new Error(`bad updated_at ${w.updated_at}`);
  return { id: w.id, status: w.status, updatedAt: new Date(ms) };
}

describe("replay of recorded Airwallex responses", () => {
  it("M0-03 PAID -> FAILED -> CANCELLED (same updated_at second) yields one incident, ends FAILED view", () => {
    const files = [
      "transition-paidfail-sent",
      "transition-paidfail-paid",
      "transition-paid-to-failed",
      "transfer-fetch-paid-then-failed",
    ];
    const snaps = files.map((f) => {
      const body = JSON.parse(readFileSync(new URL(`${f}.json`, FIXTURES), "utf8")).response
        .body as Wire;
      return snapshot(body);
    });
    expect(snaps.map((s) => s.status)).toEqual(["SENT", "PAID", "FAILED", "CANCELLED"]);
    type Snap = (typeof snaps)[number];
    let state: Snap | null = null;
    const incidents: string[] = [];
    for (const s of snaps) {
      const r: TransferUpdateResult<Snap> = applyTransferUpdate<Snap>(state, s);
      if (r.outcome === "applied" && r.incident) {
        incidents.push(`${r.incident.from}->${r.incident.to}`);
      }
      state = r.state;
    }
    expect(incidents).toEqual(["PAID->FAILED"]);
    expect(state?.status).toBe("CANCELLED");
    expect(project("CANCELLED", false)).toEqual({ view: "FAILED", held: false, final: true });
  });

  it("M0-05 webhooks in delivery order end at the highest recorded state per transfer", () => {
    const dir = new URL("webhooks/", FIXTURES);
    const byTransfer = new Map<string, { received: number; snap: ReturnType<typeof snapshot> }[]>();
    for (const name of readdirSync(dir)) {
      if (!/^payout\.transfer\.(?!funding\.)[a-z]+\.\d+(-redelivery)?\.json$/.test(name)) continue;
      const rec = JSON.parse(readFileSync(new URL(name, dir), "utf8"));
      const body = JSON.parse(rec.body_utf8) as { data: Wire };
      const list = byTransfer.get(body.data.id) ?? [];
      list.push({ received: Date.parse(rec.received_at), snap: snapshot(body.data) });
      byTransfer.set(body.data.id, list);
    }
    expect(byTransfer.size).toBeGreaterThan(0);
    let sawFailedThenCancelled = false;
    for (const events of byTransfer.values()) {
      events.sort((a, b) => a.received - b.received);
      let state: ReturnType<typeof snapshot> | null = null;
      for (const e of events) state = applyTransferUpdate(state, e.snap).state;
      const best = [...events]
        .map((e) => e.snap)
        .sort(
          (a, b) =>
            b.updatedAt.getTime() - a.updatedAt.getTime() || rank(b.status) - rank(a.status),
        )[0];
      expect(state).toEqual(best);
      const statuses = events.map((e) => e.snap.status);
      if (statuses.includes("FAILED") && statuses.includes("CANCELLED")) {
        sawFailedThenCancelled = true;
        expect(state?.status).toBe("CANCELLED");
      }
    }
    expect(sawFailedThenCancelled).toBe(true);
  });
});
