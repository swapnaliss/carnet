// The RFI state machine (architecture §4, M2-04). Pure: a closed transition table, guards and the event
// each edge emits. An illegal transition throws IllegalRfiTransitionError and is never applied.
//
//   ACTION_REQUIRED → DRAFTING → DRAFT_READY | NEEDS_OWNER → APPROVED → ANSWER_SUBMITTING → ANSWERED
//   ANSWERED → CLOSED | REOPENED;  REOPENED → DRAFTING (a new round);  any open state → EXPIRED
//
// One addition to the architecture's chain, required for order-independent ingest: Airwallex can report
// ANSWERED while Carnet never submitted (the owner answered in the Airwallex web app, or the respond
// result is only learnt from a fetch). Every pre-answer state may therefore move to ANSWERED, emitting
// `airwallex.rfi.answered_externally` instead of `airwallex.rfi.answered`.
//
// An RFI never changes a payment's money status (ADR 0006): nothing here touches a transfer.

export const RFI_STATES = [
  "ACTION_REQUIRED",
  "DRAFTING",
  "DRAFT_READY",
  "NEEDS_OWNER",
  "APPROVED",
  "ANSWER_SUBMITTING",
  "ANSWERED",
  "REOPENED",
  "CLOSED",
  "EXPIRED",
] as const;
export type RfiState = (typeof RFI_STATES)[number];

export function isRfiState(value: string): value is RfiState {
  return (RFI_STATES as readonly string[]).includes(value);
}

/** States in which Airwallex is still waiting for an answer: a linked in-flight payment is held. */
export const RFI_HOLDING_STATES: readonly RfiState[] = [
  "ACTION_REQUIRED",
  "DRAFTING",
  "DRAFT_READY",
  "NEEDS_OWNER",
  "APPROVED",
  "ANSWER_SUBMITTING",
  "REOPENED",
];

/** No further transition is possible. */
export const RFI_TERMINAL_STATES: readonly RfiState[] = ["CLOSED", "EXPIRED"];

/** The pre-answer states (before Airwallex reports ANSWERED for the current round). */
export const RFI_PRE_ANSWER_STATES: readonly RfiState[] = RFI_HOLDING_STATES;

/** Feeds `project(transferStatus, openRfi)`: true while the RFI should hold a linked payment. */
export function rfiHolds(state: RfiState): boolean {
  return RFI_HOLDING_STATES.includes(state);
}

/** Open for the per-source guard (ADR 0018 amendment 1): Airwallex requires the earlier one CLOSED. */
export function rfiIsOpen(state: RfiState): boolean {
  return !RFI_TERMINAL_STATES.includes(state);
}

export const RFI_EVENTS = [
  "rfi.drafting_started",
  "draft.ready",
  "draft.needs_owner",
  "approval.granted",
  "approval.revoked",
  "answer.submitting",
  "answer.rejected",
  "airwallex.rfi.answered",
  "airwallex.rfi.answered_externally",
  "airwallex.rfi.closed",
  "airwallex.rfi.reopened",
  "airwallex.rfi.expired",
] as const;
export type RfiEvent = (typeof RFI_EVENTS)[number];

export interface RfiTransitionRule {
  readonly from: RfiState;
  readonly to: RfiState;
  readonly event: RfiEvent;
  /** Entering DRAFTING from REOPENED starts a new round (round + 1). */
  readonly newRound: boolean;
  /** Entering DRAFTING enqueues the `rfi.draft` job in the same transaction (outbox). */
  readonly enqueueDraft: boolean;
  /** Who may cause it (documentation and the caller's guard). */
  readonly by: "ingest" | "drafting" | "owner" | "executor";
}

function rule(
  from: RfiState,
  to: RfiState,
  event: RfiEvent,
  by: RfiTransitionRule["by"],
  extra: Partial<Pick<RfiTransitionRule, "newRound" | "enqueueDraft">> = {},
): RfiTransitionRule {
  return {
    from,
    to,
    event,
    by,
    newRound: extra.newRound ?? false,
    enqueueDraft: extra.enqueueDraft ?? false,
  };
}

/** The complete transition table. Anything not listed is illegal. */
export const RFI_TRANSITIONS: readonly RfiTransitionRule[] = [
  rule("ACTION_REQUIRED", "DRAFTING", "rfi.drafting_started", "ingest", { enqueueDraft: true }),
  rule("DRAFTING", "DRAFT_READY", "draft.ready", "drafting"),
  rule("DRAFTING", "NEEDS_OWNER", "draft.needs_owner", "drafting"),
  rule("DRAFT_READY", "APPROVED", "approval.granted", "owner"),
  rule("NEEDS_OWNER", "APPROVED", "approval.granted", "owner"),
  rule("APPROVED", "ANSWER_SUBMITTING", "answer.submitting", "executor"),
  // M2-07: an approval that ended without being consumed (rejected, expired, kill switch) hands the
  // RFI back to the owner with its draft.
  rule("APPROVED", "DRAFT_READY", "approval.revoked", "owner"),
  rule("ANSWER_SUBMITTING", "ANSWERED", "airwallex.rfi.answered", "executor"),
  // M2-07: the executor refused (the RFI changed after approval) or Airwallex rejected the respond
  // with a 4xx: nothing was submitted, the owner re-drafts and approves again.
  rule("ANSWER_SUBMITTING", "NEEDS_OWNER", "answer.rejected", "executor"),
  rule("ANSWERED", "CLOSED", "airwallex.rfi.closed", "ingest"),
  rule("ANSWERED", "REOPENED", "airwallex.rfi.reopened", "ingest"),
  rule("REOPENED", "DRAFTING", "rfi.drafting_started", "ingest", {
    newRound: true,
    enqueueDraft: true,
  }),
  // Answered outside Carnet (see the header).
  ...(
    ["ACTION_REQUIRED", "DRAFTING", "DRAFT_READY", "NEEDS_OWNER", "APPROVED", "REOPENED"] as const
  ).map((from) => rule(from, "ANSWERED", "airwallex.rfi.answered_externally", "ingest")),
  // Closed by Airwallex while Carnet had not answered: the owner sees "expired, ask Airwallex".
  ...RFI_HOLDING_STATES.map((from) => rule(from, "EXPIRED", "airwallex.rfi.expired", "ingest")),
];

export class IllegalRfiTransitionError extends Error {
  readonly code = "ILLEGAL_RFI_TRANSITION";
  readonly from: RfiState;
  readonly to: RfiState;
  constructor(from: RfiState, to: RfiState) {
    super(`illegal RFI transition ${from} -> ${to}`);
    this.from = from;
    this.to = to;
    this.name = "IllegalRfiTransitionError";
  }
}

export function findRfiTransition(from: RfiState, to: RfiState): RfiTransitionRule | null {
  return RFI_TRANSITIONS.find((t) => t.from === from && t.to === to) ?? null;
}

export function canTransitionRfi(from: RfiState, to: RfiState): boolean {
  return findRfiTransition(from, to) !== null;
}

/** Returns the rule for `from -> to`, or throws IllegalRfiTransitionError. */
export function transitionRfi(from: RfiState, to: RfiState): RfiTransitionRule {
  const t = findRfiTransition(from, to);
  if (!t) throw new IllegalRfiTransitionError(from, to);
  return t;
}
