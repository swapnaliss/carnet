// The content an approval is bound to (ADR 0008, M2-07). For an RFI answer it is: business, approver,
// nonce, the RFI id and its `updated_at`, every question's id and text, every answer's text, the
// attachments' document ids and SHA-256, the evidence fact versions shown, the draft id and the prompt
// version. The draft and fact inputs come through this typed interface: M2-05 drafts plug in by
// producing an `RfiAnswerSubject`; payout and conversion variants join the union in M3-03.
import type { BusinessId, UserId } from "../ids";
import { sha256Hex } from "../planner/sha256";
import { approvalCanonicalJson } from "./canonical";

export const APPROVAL_KINDS = ["rfi_answer"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "CONSUMED",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Why an approval ended without being consumed (stored with the status). */
export const APPROVAL_END_REASONS = [
  "REJECTED_BY_USER",
  "SUPERSEDED",
  "TTL",
  "KILL_SWITCH",
  "RFI_CHANGED",
] as const;
export type ApprovalEndReason = (typeof APPROVAL_END_REASONS)[number];

/** PENDING -> APPROVED | REJECTED | EXPIRED, APPROVED -> REJECTED | EXPIRED | CONSUMED. */
const APPROVAL_EDGES: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  PENDING: ["APPROVED", "REJECTED", "EXPIRED"],
  APPROVED: ["REJECTED", "EXPIRED", "CONSUMED"],
  REJECTED: [],
  EXPIRED: [],
  CONSUMED: [],
};
export function canTransitionApproval(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return APPROVAL_EDGES[from].includes(to);
}

export interface ApprovalQuestion {
  /** The Airwallex question id. */
  readonly id: string;
  readonly text: string;
}

export interface ApprovalAttachment {
  readonly documentId: string;
  /** Lower-case hex SHA-256 of the document's bytes. */
  readonly sha256: string;
}

export interface ApprovalAnswer {
  readonly questionId: string;
  /** The Airwallex answer type the answer is sent as. */
  readonly type: "TEXT" | "ATTACHMENT";
  /** The answer text (TEXT), or the optional comment sent with attachments (ATTACHMENT; "" when none). */
  readonly text: string;
  readonly attachments: readonly ApprovalAttachment[];
  /** The evidence fact versions the approver was shown for this answer. */
  readonly factVersionIds: readonly string[];
}

export interface RfiAnswerSubject {
  readonly kind: "rfi_answer";
  readonly businessId: BusinessId;
  readonly approverId: UserId;
  readonly nonce: string;
  readonly rfiId: string;
  /** The RFI's Airwallex `updated_at` as an ISO instant (UTC, milliseconds). */
  readonly rfiUpdatedAt: string;
  readonly draftId: string;
  readonly promptVersion: string;
  readonly questions: readonly ApprovalQuestion[];
  readonly answers: readonly ApprovalAnswer[];
}

/** Grows by one member per approval kind (payout, conversion: M3-03). */
export type ApprovalSubject = RfiAnswerSubject;

/** SHA-256 (lower-case hex) over the canonical JSON of every field of the subject. */
export function approvalHash(subject: ApprovalSubject): string {
  return sha256Hex(approvalCanonicalJson(subject));
}

/** The question text that is shown, hashed and compared: English title, then description, else Chinese. */
export function approvalQuestionText(
  title: { en: string | null; zh: string | null },
  description: { en: string | null; zh: string | null },
): string {
  const t = title.en ?? title.zh ?? "";
  const d = description.en ?? description.zh ?? "";
  return d === "" ? t : t === "" ? d : `${t}\n${d}`;
}

/** Approvals expire this long before the RFI does. */
export const APPROVAL_EXPIRY_MARGIN_MS = 5 * 60 * 1000;
export const DEFAULT_APPROVAL_TTL_MINUTES = 30;

/**
 * `now + ttl`, capped at the RFI's `expires_at` minus the margin. Null when that instant is not in the
 * future ("too close to expiry": nothing is approved).
 */
export function approvalExpiry(input: {
  now: Date;
  ttlMinutes: number;
  rfiExpiresAt: Date | null;
  marginMs?: number;
}): Date | null {
  const byTtl = input.now.getTime() + input.ttlMinutes * 60_000;
  const cap =
    input.rfiExpiresAt === null
      ? Number.POSITIVE_INFINITY
      : input.rfiExpiresAt.getTime() - (input.marginMs ?? APPROVAL_EXPIRY_MARGIN_MS);
  const at = Math.min(byTtl, cap);
  return at > input.now.getTime() ? new Date(at) : null;
}
