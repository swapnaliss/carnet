// The executor's refusal codes (ADR 0008): every refusal to send carries one, stored on the attempt and
// in the audit log. The hash itself is `approvalHash(subject)` in subject.ts.
import { type ApprovalSubject, approvalHash } from "./subject";

export const APPROVAL_REFUSAL_CODES = [
  "HASH_MISMATCH",
  "RFI_NOT_ACTION_REQUIRED",
  "RFI_UPDATED",
  "QUESTIONS_CHANGED",
  "ATTACHMENT_CHANGED",
  "ATTACHMENT_MISSING",
  "ATTACHMENT_UNSUPPORTED",
  "APPROVAL_NOT_CONSUMABLE",
  "KILL_SWITCH",
] as const;
export type ApprovalRefusalCode = (typeof APPROVAL_REFUSAL_CODES)[number];

/** True when the subject re-derived from current state hashes to the approved hash. */
export function hashMatches(approvedHash: string, current: ApprovalSubject): boolean {
  return approvalHash(current) === approvedHash;
}
