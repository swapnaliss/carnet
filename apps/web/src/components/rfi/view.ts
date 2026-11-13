// Pure logic of the hold screen (M2-08): no React, no I/O, so `rfi-ui` unit tests cover it directly.
// The screen shows server state only; these functions derive what is shown from a `HoldView` and build
// the approve request from exactly that same data (ADR 0017: no optimistic updates).
import type { AnswerDto, CitationDto, HoldView, QuestionDto } from "@/server/hold";

export type HoldRfi = HoldView["rfi"];

/** States in which Carnet or Airwallex is still moving, so the screen polls every 3 s (ADR 0017). */
export const POLLING_STATES = [
  "DRAFTING",
  "ANSWER_SUBMITTING",
  "ACTION_REQUIRED",
  "APPROVED",
] as const;

export function shouldPoll(view: HoldView): boolean {
  return (POLLING_STATES as readonly string[]).includes(view.rfi.state);
}

export type QuestionStatus = "drafting" | "ready" | "needs_owner" | "yours";

export function questionStatus(q: QuestionDto, rfiState: string): QuestionStatus {
  if (!q.answer)
    return rfiState === "DRAFTING" || rfiState === "ACTION_REQUIRED" ? "drafting" : "needs_owner";
  if (q.answer.status === "NEEDS_OWNER") return "needs_owner";
  if (q.answer.status === "OWNER_AUTHORED") return "yours";
  return "ready";
}

/** Whether the latest draft for this question was written by the owner (an edit or a fresh answer). */
export function isOwnerDraft(view: HoldView): boolean {
  return view.draft?.origin === "owner";
}

export function countQuestions(view: HoldView) {
  const statuses = view.questions.map((q) => questionStatus(q, view.rfi.state));
  return {
    total: statuses.length,
    ready: statuses.filter((s) => s === "ready" || s === "yours").length,
    needs: statuses.filter((s) => s === "needs_owner").length,
    drafting: statuses.filter((s) => s === "drafting").length,
  };
}

// ---------------------------------------------------------------------------------------------
// Reason codes to plain language (the key into t.hold.needsOwner)

export type NeedsOwnerKey =
  | "noDocument"
  | "verifierRejected"
  | "imageOnly"
  | "contradiction"
  | "modelUnavailable"
  | "unsupported"
  | "staleReuse";

export function needsOwnerKey(reasonCode: string | null): NeedsOwnerKey {
  switch (reasonCode) {
    case "CANNOT_ANSWER":
    case "ANSWER_MISSING":
    case "NO_CITATIONS":
    case "ATTACHMENT_NONE_SELECTED":
      return "noDocument";
    case "ATTACHMENT_NOT_VERIFIED":
      return "imageOnly";
    case "CONFLICTING_FACTS":
      return "contradiction";
    case "MODEL_UNAVAILABLE":
      return "modelUnavailable";
    case "UNSUPPORTED_ANSWER_TYPE":
      return "unsupported";
    case "REUSE_STALE":
    case "STALE_REUSE":
      return "staleReuse";
    default:
      return "verifierRejected";
  }
}

// ---------------------------------------------------------------------------------------------
// Follow-up rounds (M3-05)

export type FollowUpBadge = "reused" | "new_draft" | "needs_you";

/** The badge of a question in round 2 or later; null in round 1 (nothing to compare with). */
export function followUpBadge(q: QuestionDto, rfiState: string): FollowUpBadge | null {
  if (!q.follow_up) return null;
  const status = questionStatus(q, rfiState);
  if (status === "needs_owner") return "needs_you";
  if (q.answer?.reuse) return "reused";
  return "new_draft";
}

export function followUpCounts(view: HoldView) {
  const badges = view.questions.map((q) => followUpBadge(q, view.rfi.state));
  return {
    reused: badges.filter((b) => b === "reused").length,
    fresh: badges.filter((b) => b === "new_draft").length,
    needs: badges.filter((b) => b === "needs_you").length,
  };
}

/** True when every question of a follow-up round is answered from an earlier approval. */
export function allAnswersReused(view: HoldView): boolean {
  return (
    view.rfi.round > 1 &&
    view.questions.length > 0 &&
    view.questions.every((q) => followUpBadge(q, view.rfi.state) === "reused")
  );
}

/** The questions that block the whole RFI, by 1-based position and title. */
export function blockingQuestions(view: HoldView): { position: number; title: string }[] {
  return view.questions.flatMap((q, i) =>
    questionStatus(q, view.rfi.state) === "needs_owner"
      ? [{ position: i + 1, title: q.title }]
      : [],
  );
}

// ---------------------------------------------------------------------------------------------
// Claims: the sentence-level spans of an answer, each with the citations that support it.

export interface Claim {
  /** 1-based number among the claims that carry a source; 0 for connective text with none. */
  readonly n: number;
  readonly text: string;
  readonly citations: readonly CitationDto[];
}

const TOKEN = /[\p{L}\p{N}]+(?:[.\-/][\p{L}\p{N}]+)*/gu;

function tokens(text: string): Set<string> {
  // "7,200.00" and "7200.00" are the same figure.
  const flat = text.toLowerCase().replace(/(\d),(?=\d)/g, "$1");
  const out = new Set<string>();
  for (const m of flat.matchAll(TOKEN)) {
    const tok = m[0];
    if (/\d/.test(tok) || tok.length >= 4) out.add(tok);
  }
  return out;
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}])/u)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function claimsOf(answer: AnswerDto): Claim[] {
  const sentences = splitSentences(answer.text);
  const factTokens = answer.citations.map((c) => tokens(`${c.value} ${c.quote}`));
  const valueTokens = answer.citations.map((c) => tokens(c.value));
  const matched = sentences.map((s) => {
    const st = tokens(s);
    return answer.citations.filter((_c, i) => {
      const vt = valueTokens[i];
      const ft = factTokens[i];
      if (!vt || !ft) return false;
      for (const tok of vt) if (st.has(tok)) return true;
      return false;
    });
  });
  // A cited answer whose sentences matched nothing still shows its sources against the first one.
  if (answer.citations.length > 0 && matched.every((m) => m.length === 0) && matched.length > 0) {
    matched[0] = [...answer.citations];
  }
  let n = 0;
  return sentences.map((text, i) => {
    const citations = matched[i] ?? [];
    return { n: citations.length > 0 ? ++n : 0, text, citations };
  });
}

/** Groups citations by quote so one snippet lists every claim that cites it. */
export interface SnippetGroup {
  readonly citation: CitationDto;
  readonly claims: readonly number[];
}

export function snippetGroups(claims: readonly Claim[], answer: AnswerDto): SnippetGroup[] {
  const groups = new Map<string, { citation: CitationDto; claims: number[] }>();
  for (const claim of claims) {
    for (const c of claim.citations) {
      const g = groups.get(c.fact_version_id) ?? { citation: c, claims: [] };
      if (claim.n > 0 && !g.claims.includes(claim.n)) g.claims.push(claim.n);
      groups.set(c.fact_version_id, g);
    }
  }
  // Cited facts no sentence matched are still shown: nothing the draft cites is hidden.
  for (const c of answer.citations) {
    if (!groups.has(c.fact_version_id)) groups.set(c.fact_version_id, { citation: c, claims: [] });
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------------------------------------
// The approval gate and the request body

// Same as the StaleBanner (15 s): while the screen says its data may be out of date, approve is off.
export const STALE_APPROVE_AFTER_MS = 15_000;

export type GateReason =
  | "VIEWER"
  | "EXPIRED"
  | "NOT_READY"
  | "DRAFTING"
  | "NEEDS_OWNER"
  | "STALE_DATA"
  | "KILL_SWITCH"
  | "TOO_CLOSE"
  | "SOURCE_FAILED"
  | "NO_DRAFT"
  | "APPROVAL_PENDING"
  | "ANSWERED"
  | "UNLINKED";

export interface Gate {
  readonly enabled: boolean;
  readonly reason: GateReason | null;
  /** 1-based positions of the questions that block (for NEEDS_OWNER). */
  readonly blocking: readonly number[];
}

/** Mirrors the server's refusals so the button explains itself; the server enforces them anyway. */
export function approveGate(view: HoldView, ctx: { now: number; lastSuccessAt: number }): Gate {
  const closed = (reason: GateReason): Gate => ({ enabled: false, reason, blocking: [] });
  const state = view.rfi.state;
  if (view.role === "viewer") return closed("VIEWER");
  if (view.rfi.expired || state === "EXPIRED" || state === "CLOSED") return closed("EXPIRED");
  if (state === "ANSWERED" || state === "ANSWER_SUBMITTING") return closed("ANSWERED");
  if (state === "APPROVED") return closed("APPROVAL_PENDING");
  if (state === "DRAFTING" || state === "ACTION_REQUIRED") return closed("DRAFTING");
  if (state !== "DRAFT_READY" && state !== "NEEDS_OWNER") return closed("NOT_READY");
  if (!view.draft) return closed("NO_DRAFT");
  if (view.payment === null) return closed("UNLINKED");
  const blocking = view.questions
    .map((q, i) => ({ q, position: i + 1 }))
    .filter(({ q }) => questionStatus(q, state) === "needs_owner" || q.answer === null)
    .map(({ position }) => position);
  if (blocking.length > 0) return { enabled: false, reason: "NEEDS_OWNER", blocking };
  if (view.questions.some((q) => (q.answer?.unresolved_citations.length ?? 0) > 0)) {
    return closed("SOURCE_FAILED");
  }
  if (ctx.now - ctx.lastSuccessAt > STALE_APPROVE_AFTER_MS) return closed("STALE_DATA");
  if (!view.execution_enabled) return closed("KILL_SWITCH");
  if (view.rfi.expires_at) {
    const margin = 5 * 60_000; // the server's APPROVAL_EXPIRY_MARGIN_MS
    if (new Date(view.rfi.expires_at).getTime() - margin <= new Date(view.server_time).getTime()) {
      return closed("TOO_CLOSE");
    }
  }
  return { enabled: true, reason: null, blocking: [] };
}

export interface ApproveBody {
  readonly draft_id: string;
  readonly prompt_version: string;
  readonly rfi_updated_at: string;
  readonly answers: readonly {
    readonly question_id: string;
    readonly status: "ANSWERED" | "NEEDS_OWNER";
    readonly type: "TEXT" | "ATTACHMENT";
    readonly text: string;
    readonly document_ids: readonly string[];
    readonly fact_version_ids: readonly string[];
  }[];
}

/**
 * The approve request for exactly what the view shows: the same draft id, the same text, the same
 * attachments, the same cited fact versions, the RFI `updated_at` the owner looked at. The dialog
 * renders from this object too, so what is shown and what is sent cannot differ.
 */
export function buildApproveBody(view: HoldView): ApproveBody | null {
  if (!view.draft) return null;
  return {
    draft_id: view.draft.id,
    // An owner draft has no prompt version; the server needs a non-empty string to bind.
    prompt_version: view.draft.prompt_version ?? "owner-edit",
    rfi_updated_at: view.rfi.airwallex_updated_at,
    answers: view.questions.map((q) => ({
      question_id: q.airwallex_question_id,
      status: q.answer && q.answer.status !== "NEEDS_OWNER" ? "ANSWERED" : "NEEDS_OWNER",
      type: q.answer_type === "ATTACHMENT" ? "ATTACHMENT" : "TEXT",
      text: q.answer?.text ?? "",
      document_ids:
        q.answer_type === "ATTACHMENT" ? (q.answer?.documents.map((d) => d.id) ?? []) : [],
      fact_version_ids: q.answer?.citations.map((c) => c.fact_version_id) ?? [],
    })),
  };
}

/** Statements the owner wrote that no document supports (listed in the approval dialog). */
export function unverifiedStatements(view: HoldView): { position: number; text: string }[] {
  return view.questions.flatMap((q, i) =>
    q.answer?.status === "OWNER_AUTHORED" ? [{ position: i + 1, text: q.answer.text }] : [],
  );
}

/** What changed between two views of the same RFI, for the live-region announcement. */
export function describeChange(prev: HoldView, next: HoldView): "state" | "drafts" | null {
  if (prev.rfi.state !== next.rfi.state) return "state";
  if (prev.draft?.id !== next.draft?.id) return "drafts";
  return null;
}

export function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
