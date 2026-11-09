// Answer reuse (M2-06): the provenance the API shows as "same as approved on <date>" and the shape of a
// remembered answer. Reuse never skips the verifier or the approval (R6): it only saves typing.

/** Where a reused answer came from. Stored with the draft answer and returned by the API. */
export interface ReuseProvenance {
  readonly reused: true;
  /** ISO instant the source approval was consumed (the answer was approved and submitted). */
  readonly approved_on: string;
  readonly source_approval_id: string;
  readonly memory_id: string;
}

/** A citation as remembered: the fact it pointed to when approved, so a changed fact is detectable. */
export interface MemoryCitation {
  readonly fact_version_id: string;
  readonly quote: string;
  readonly document_id: string;
  readonly key: string;
}

export interface MemoryAttachment {
  readonly document_id: string;
  readonly sha256: string;
}

/** One remembered, approved answer. */
export interface MemoryEntry {
  readonly id: string;
  readonly answerText: string;
  readonly citations: readonly MemoryCitation[];
  readonly attachments: readonly MemoryAttachment[];
  readonly approvedAt: Date;
  readonly sourceApprovalId: string;
}

export function provenanceOf(entry: MemoryEntry): ReuseProvenance {
  return {
    reused: true,
    approved_on: entry.approvedAt.toISOString(),
    source_approval_id: entry.sourceApprovalId,
    memory_id: entry.id,
  };
}
