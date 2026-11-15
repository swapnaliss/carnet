// M4-06 load test: the workload plan, shared by the generator (run.ts) and the worker (worker.ts).
//
// The workload is the recorded M2-09 live run (fixtures/airwallex/m2-run/webhooks): the nine events
// one sandbox payment produced, in the order Carnet received them (seven `payout.transfer.*`, then
// `rfi.action_required` and `rfi.closed`). Each synthetic payment replays that sequence with its own
// transfer id, request id, RFI id and event ids. Bodies are re-signed per run with a generated secret.
//
// Realism (ticket scope 2): about 10% of deliveries are repeated (same event id, later), and about a
// third of payments get two adjacent events swapped (out-of-order delivery). Arrivals are open-loop:
// exponential gaps at the profile rate, scheduled by wall clock, never waiting for a response.
//
// The worker answers `GET /transfers/{id}` and `GET /rfis/{id}` with the state the payment has
// reached by "now" in the plan (the highest sequence step already sent), so a late or duplicate
// delivery fetches the current object exactly as in production.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const WEBHOOK_FIXTURE_DIR = fileURLToPath(
  new URL("../../fixtures/airwallex/m2-run/webhooks/", import.meta.url),
);
/** The recorded payment whose events are the template (the one that reached PAID in M2-09). */
export const TEMPLATE_TRANSFER_ID = "2662e6a4-e664-4d74-be1f-9889655df125";
export const TEMPLATE_REQUEST_ID = "8fa8af97-41f9-45bf-8eaf-d5c19952d076";
export const TEMPLATE_RFI_ID = "18e60744-857c-4c6c-af2e-42e132e7db4c";

export interface Profile {
  name: "average" | "peak" | "burst";
  /** Deliveries per second (open-loop arrival rate). */
  rate: number;
  durationS: number;
}

/** docs/architecture.md §12 rates: 0.17/s average, about 2/s at a 10x peak, 20/s sandbox limit. */
export const PROFILES: Record<Profile["name"], Profile> = {
  average: { name: "average", rate: 0.17, durationS: 180 },
  peak: { name: "peak", rate: 2, durationS: 60 },
  // 20 s keeps one source IP under the route's 600/min limit (a 20/s stream from one IP would be
  // refused after 30 s: see docs/evidence/load-test.md).
  burst: { name: "burst", rate: 20, durationS: 20 },
};

export interface TemplateEvent {
  name: string;
  rawBody: string;
}

/** The template payment's events, in received order (file names start with HHMMSS). */
export function templateEvents(): TemplateEvent[] {
  return readdirSync(WEBHOOK_FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map(
      (f) =>
        JSON.parse(readFileSync(`${WEBHOOK_FIXTURE_DIR}${f}`, "utf8")) as {
          name: string;
          raw_body: string;
        },
    )
    .filter((d) => {
      const body = JSON.parse(d.raw_body) as { data: { id: string } };
      return (
        body.data.id === TEMPLATE_TRANSFER_ID ||
        (d.name.startsWith("rfi.") && body.data.id === TEMPLATE_RFI_ID)
      );
    })
    .map((d) => ({ name: d.name, rawBody: d.raw_body }));
}

export interface PlannedPayment {
  index: number;
  transferId: string;
  requestId: string;
  rfiId: string;
}

export interface Delivery {
  /** Milliseconds after the profile start. */
  atMs: number;
  paymentIndex: number;
  /** Position of this event in the payment's true sequence (0-based). */
  step: number;
  eventId: string;
  name: string;
  body: string;
  duplicate: boolean;
}

export interface ProfilePlan {
  profile: Profile;
  payments: PlannedPayment[];
  deliveries: Delivery[];
  /** Number of distinct events (deliveries minus duplicates). */
  uniqueEvents: number;
}

/** Deterministic PRNG (mulberry32) so a run can be repeated. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function personalise(raw: string, p: PlannedPayment, eventId: string, oldEventId: string): string {
  return raw
    .replaceAll(TEMPLATE_TRANSFER_ID, p.transferId)
    .replaceAll(TEMPLATE_REQUEST_ID, p.requestId)
    .replaceAll(TEMPLATE_RFI_ID, p.rfiId)
    .replaceAll(oldEventId, eventId);
}

/**
 * Builds a profile: enough payments to fill `rate x duration` deliveries, each payment's events
 * spread over the run in sequence (with occasional adjacent swaps), plus ~10% duplicate deliveries.
 */
export function buildPlan(
  profile: Profile,
  options: { seed: number; duplicateShare?: number; swapShare?: number },
): ProfilePlan {
  const rand = rng(options.seed);
  const dupShare = options.duplicateShare ?? 0.1;
  const swapShare = options.swapShare ?? 0.33;
  const template = templateEvents();
  const totalDeliveries = Math.max(1, Math.round(profile.rate * profile.durationS));
  const uniqueTarget = Math.max(template.length, Math.round(totalDeliveries / (1 + dupShare)));
  const paymentCount = Math.max(1, Math.round(uniqueTarget / template.length));

  const payments: PlannedPayment[] = Array.from({ length: paymentCount }, (_, index) => ({
    index,
    transferId: randomUUID(),
    requestId: randomUUID(),
    rfiId: randomUUID(),
  }));

  // Per payment: its events in true order, then maybe one adjacent swap (out-of-order delivery).
  type Ev = Omit<Delivery, "atMs" | "duplicate">;
  const queues: Ev[][] = payments.map((p) => {
    const evs: Ev[] = template.map((t, step) => {
      const old = (JSON.parse(t.rawBody) as { id: string }).id;
      const eventId = randomUUID();
      return {
        paymentIndex: p.index,
        step,
        eventId,
        name: t.name,
        body: personalise(t.rawBody, p, eventId, old),
      };
    });
    if (rand() < swapShare) {
      const i = Math.floor(rand() * (evs.length - 1));
      const a = evs[i] as Ev;
      evs[i] = evs[i + 1] as Ev;
      evs[i + 1] = a;
    }
    return evs;
  });

  // Interleave: payments start staggered, so many payments are in flight at once.
  const order: Ev[] = [];
  const cursors = queues.map(() => 0);
  let remaining = queues.reduce((n, q) => n + q.length, 0);
  while (remaining > 0) {
    for (let i = 0; i < queues.length; i++) {
      const q = queues[i] as Ev[];
      const c = cursors[i] as number;
      if (c < q.length && rand() < 0.6) {
        order.push(q[c] as Ev);
        cursors[i] = c + 1;
        remaining -= 1;
      }
    }
  }

  // Duplicates: a copy of ~dupShare of the events, re-delivered 1-8 positions later.
  const withDupes: { ev: Ev; duplicate: boolean }[] = order.map((ev) => ({ ev, duplicate: false }));
  for (const ev of order) {
    if (rand() < dupShare) {
      // Always after the original (Airwallex redelivers a delivered event).
      const original = withDupes.findIndex((x) => x.ev === ev && !x.duplicate);
      const at = Math.min(withDupes.length, original + 1 + Math.floor(rand() * 8));
      withDupes.splice(at, 0, { ev, duplicate: true });
    }
  }

  // Open-loop arrival times: exponential gaps at `rate`, scaled to fit the duration exactly.
  const gaps = withDupes.map(() => -Math.log(1 - rand()) / profile.rate);
  const sum = gaps.reduce((a, b) => a + b, 0);
  const scale = (profile.durationS * 1000) / sum;
  let t = 0;
  const deliveries: Delivery[] = withDupes.map(({ ev, duplicate }, i) => {
    const d: Delivery = { ...ev, atMs: Math.round(t), duplicate };
    t += (gaps[i] as number) * scale;
    return d;
  });

  return { profile, payments, deliveries, uniqueEvents: order.length };
}

/** What the worker needs: per transfer/RFI, each step's body and its absolute send time. */
export interface ReplayIndex {
  /** transferId -> sorted [{ sendAt, step, data }] for transfer events. */
  transfers: Record<string, { sendAt: number; step: number; data: unknown }[]>;
  /** rfiId -> { transferId, steps: [{ sendAt, step, status }] }. */
  rfis: Record<
    string,
    { transferId: string; steps: { sendAt: number; step: number; name: string }[] }
  >;
}

export function replayIndex(plan: ProfilePlan, startEpochMs: number): ReplayIndex {
  const index: ReplayIndex = { transfers: {}, rfis: {} };
  for (const d of plan.deliveries) {
    if (d.duplicate) continue;
    const p = plan.payments[d.paymentIndex] as PlannedPayment;
    const body = JSON.parse(d.body) as { data: unknown };
    if (d.name.startsWith("payout.transfer.")) {
      index.transfers[p.transferId] ??= [];
      index.transfers[p.transferId]?.push({
        sendAt: startEpochMs + d.atMs,
        step: d.step,
        data: body.data,
      });
    } else if (d.name.startsWith("rfi.")) {
      index.rfis[p.rfiId] ??= { transferId: p.transferId, steps: [] };
      index.rfis[p.rfiId]?.steps.push({
        sendAt: startEpochMs + d.atMs,
        step: d.step,
        name: d.name,
      });
    }
  }
  return index;
}

/** The highest true-sequence step already delivered at `now` (or the first step if none yet). */
export function currentStep<T extends { sendAt: number; step: number }>(
  steps: T[],
  now: number,
): T | undefined {
  const sent = steps.filter((s) => s.sendAt <= now);
  const pool = sent.length > 0 ? sent : steps;
  return pool.reduce<T | undefined>(
    (best, s) => (best === undefined || s.step > best.step ? s : best),
    undefined,
  );
}
