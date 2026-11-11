// Follow-up rounds (M3-05). When Airwallex reopens an answered RFI (`POST /simulation/rfis/{id}/follow_up`)
// the active request lists every question again: the reopened ones under their ORIGINAL Airwallex id and
// any appended ones under a new id (OBSERVED, fixtures `rfi-followup-reopen-and-append`). This module is the
// pure part: it classifies each question of the new round against the earlier rounds so the ingest can
// record which were reopened and which are new, and the hold screen can show a diff of changed wording.
// No I/O: the callers load the rows.
import { approvalQuestionText, normalizeQuestionText } from "@carnet/domain";

export interface RoundQuestionText {
  readonly airwallexQuestionId: string;
  readonly title: { readonly en: string | null; readonly zh: string | null };
  readonly description: { readonly en: string | null; readonly zh: string | null };
}

/** `unchanged`: reopened, same wording. `changed`: reopened, different wording. `new`: appended. */
export type FollowUpKind = "unchanged" | "changed" | "new";

export interface FollowUpQuestion {
  readonly airwallexQuestionId: string;
  readonly kind: FollowUpKind;
  /** The earlier wording of a reopened question (null for a new one). */
  readonly previous: { readonly title: string; readonly description: string } | null;
}

const textOf = (q: RoundQuestionText): string =>
  normalizeQuestionText(approvalQuestionText(q.title, q.description));

/**
 * `earlier`: the questions of every round before this one, oldest first (the newest wording of an id
 * wins). `current`: this round's questions. A question is reopened when its Airwallex id was asked
 * before; its wording is compared with the same normalisation the answer-memory fingerprint uses.
 */
export function classifyFollowUp(
  earlier: readonly RoundQuestionText[],
  current: readonly RoundQuestionText[],
): FollowUpQuestion[] {
  const before = new Map<string, RoundQuestionText>();
  for (const q of earlier) before.set(q.airwallexQuestionId, q);
  return current.map((q) => {
    const prior = before.get(q.airwallexQuestionId);
    if (!prior) return { airwallexQuestionId: q.airwallexQuestionId, kind: "new", previous: null };
    return {
      airwallexQuestionId: q.airwallexQuestionId,
      kind: textOf(prior) === textOf(q) ? "unchanged" : "changed",
      previous: {
        title: prior.title.en ?? prior.title.zh ?? "",
        description: prior.description.en ?? prior.description.zh ?? "",
      },
    };
  });
}

/** The Airwallex ids of a round's reopened and new questions, as recorded on the audit trail. */
export function summariseFollowUp(classified: readonly FollowUpQuestion[]): {
  reopened: string[];
  new: string[];
} {
  return {
    reopened: classified.filter((c) => c.kind !== "new").map((c) => c.airwallexQuestionId),
    new: classified.filter((c) => c.kind === "new").map((c) => c.airwallexQuestionId),
  };
}
