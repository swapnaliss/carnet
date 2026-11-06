// Ingest planning (M2-04): given Carnet's stored RFI and a freshly fetched Airwallex snapshot, decide
// whether the snapshot is stale and which state-machine edges to walk. Pure; the worker applies the plan
// under a row lock. Webhook payloads are never read: the snapshot is always a fetched object.
//
// Ordering: Airwallex `updated_at` has 1-second resolution, and the recorded follow-up and its answer
// share one second (rfi-followup-fetch, rfi-followup-fetch-after-respond). A snapshot's version is
// therefore (updated_at, round, status rank), compared in that order, where the round is the open
// request's (answered requests + 1) or the last answered one's.
//
// The final state depends only on the newest snapshot, whatever order the events arrive in:
//   ACTION_REQUIRED  → DRAFTING for the snapshot's round (round = answered requests + 1)
//   ANSWERED         → ANSWERED
//   CLOSED           → CLOSED when the newest answered request carries answers, else EXPIRED
// and a snapshot on a later round than the stored one walks ANSWERED → REOPENED first.
import {
  RFI_TERMINAL_STATES,
  type RfiState,
  type RfiTransitionRule,
  transitionRfi,
} from "./state-machine";

export const AIRWALLEX_RFI_STATUSES = ["ACTION_REQUIRED", "ANSWERED", "CLOSED"] as const;
export type AirwallexRfiStatus = (typeof AIRWALLEX_RFI_STATUSES)[number];

export interface RfiVersion {
  readonly updatedAt: Date;
  readonly answeredRequests: number;
  readonly status: AirwallexRfiStatus;
}

export interface RfiSnapshot extends RfiVersion {
  /** The newest answered request has an answer on every question (false when there is none). */
  readonly newestAnsweredHasAnswers: boolean;
}

export interface StoredRfiState {
  readonly state: RfiState;
  readonly round: number;
  readonly version: RfiVersion;
}

const STATUS_RANK: Record<AirwallexRfiStatus, number> = {
  ACTION_REQUIRED: 0,
  ANSWERED: 1,
  CLOSED: 2,
};

/** -1, 0 or 1 as `a` is older than, equal to or newer than `b`. */
export function compareRfiVersion(a: RfiVersion, b: RfiVersion): -1 | 0 | 1 {
  const keys = [
    a.updatedAt.getTime() - b.updatedAt.getTime(),
    snapshotRound(a) - snapshotRound(b),
    STATUS_RANK[a.status] - STATUS_RANK[b.status],
  ];
  for (const d of keys) if (d !== 0) return d < 0 ? -1 : 1;
  return 0;
}

/** The round the snapshot is on: the open request's, or the last answered one's. */
export function snapshotRound(s: Pick<RfiVersion, "status" | "answeredRequests">): number {
  return s.status === "ACTION_REQUIRED" ? s.answeredRequests + 1 : Math.max(1, s.answeredRequests);
}

export type RfiIngestPlan =
  | { readonly outcome: "stale" | "duplicate" }
  /** The stored RFI is CLOSED or EXPIRED; nothing can change it (a newer snapshot is only recorded). */
  | { readonly outcome: "terminal" }
  | {
      readonly outcome: "apply";
      /** True when no row exists yet: create it in ACTION_REQUIRED, then walk `steps`. */
      readonly create: boolean;
      readonly steps: readonly RfiTransitionRule[];
      readonly round: number;
      readonly finalState: RfiState;
    };

export function planRfiIngest(stored: StoredRfiState | null, snap: RfiSnapshot): RfiIngestPlan {
  if (stored) {
    const cmp = compareRfiVersion(snap, stored.version);
    if (cmp < 0) return { outcome: "stale" };
    if (cmp === 0) return { outcome: "duplicate" };
    if (RFI_TERMINAL_STATES.includes(stored.state)) return { outcome: "terminal" };
  }
  const target = snapshotRound(snap);
  const steps: RfiTransitionRule[] = [];
  let cur: RfiState = stored ? stored.state : "ACTION_REQUIRED";
  const go = (to: RfiState) => {
    steps.push(transitionRfi(cur, to));
    cur = to;
  };

  if (stored && target > stored.round) {
    // Airwallex moved to a later round (a follow-up): the stored round was answered, then reopened.
    if (cur !== "ANSWERED") go("ANSWERED");
    go("REOPENED");
  }
  switch (snap.status) {
    case "ACTION_REQUIRED":
      if (cur === "ACTION_REQUIRED" || cur === "REOPENED") go("DRAFTING");
      break;
    case "ANSWERED":
      if (cur !== "ANSWERED") go("ANSWERED");
      break;
    case "CLOSED":
      if (cur === "ANSWERED") go("CLOSED");
      else if (snap.newestAnsweredHasAnswers) {
        go("ANSWERED");
        go("CLOSED");
      } else go("EXPIRED");
      break;
  }
  const round = stored ? Math.max(stored.round, target) : target;
  return { outcome: "apply", create: stored === null, steps, round, finalState: cur };
}

/** Owner warning window before an RFI's `expires_at` (the UI shows "expiring soon"). */
export const RFI_EXPIRING_SOON_MS = 48 * 60 * 60 * 1000;

/** True for an RFI still waiting for an answer whose deadline is within the window (or already past). */
export function rfiExpiringSoon(
  state: RfiState,
  expiresAt: Date | null,
  now: Date,
  windowMs: number = RFI_EXPIRING_SOON_MS,
): boolean {
  if (expiresAt === null || RFI_TERMINAL_STATES.includes(state) || state === "ANSWERED") {
    return false;
  }
  return expiresAt.getTime() - now.getTime() <= windowMs;
}
