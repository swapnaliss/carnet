// Answer memory (M2-06, architecture §5 and §13). Insert-only: `recordApprovedAnswers` is the only
// writer, there is no update or delete, the app role has no UPDATE or DELETE and a trigger refuses both
// for every role (migration 0013). Reuse is exact: `findReusable` matches the normalised fingerprint of
// counterparty + answer type + question text and nothing else; the newest approval wins.
//
// Tenant repository: `ctx` first, every statement scoped by `ctx.businessId`.
import {
  type ApprovalAnswer,
  type ApprovalId,
  type AttemptId,
  approvalQuestionText,
  type CounterpartyId,
  FP_VERSION,
  fingerprint,
  type MemoryAttachment,
  type MemoryCitation,
  type MemoryEntry,
  type RfiAnswerSubject,
  type RfiId,
} from "@carnet/domain";
import { and, desc, eq } from "drizzle-orm";
import { answerMemory, documentFacts } from "../schema/index";
import { getApproval } from "./approvals";
import type { RepoCtx } from "./context";
import { getDraft } from "./drafts";
import { getAttempt } from "./execution-attempts";
import { getPayment } from "./payments";
import { getRfi, listRfiQuestions, type Rfi, type RfiQuestionRow } from "./rfis";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = typeof answerMemory.$inferSelect;

const toEntry = (r: Row): MemoryEntry => ({
  id: r.id,
  answerText: r.answerText,
  citations: r.citations as MemoryCitation[],
  attachments: r.attachments as MemoryAttachment[],
  approvedAt: r.approvedAt,
  sourceApprovalId: r.sourceApprovalId,
});

export interface StoredMemory extends MemoryEntry {
  readonly counterpartyId: CounterpartyId;
  readonly questionId: string;
  readonly answerType: string;
  readonly fingerprint: string;
  readonly fpVersion: number;
}

/** The business's remembered answers, newest approval first (an owner-facing list and the tests). */
export async function listAnswerMemory(ctx: RepoCtx, limit = 200): Promise<StoredMemory[]> {
  const rows = await ctx.db
    .select()
    .from(answerMemory)
    .where(eq(answerMemory.businessId, ctx.businessId))
    .orderBy(desc(answerMemory.approvedAt), desc(answerMemory.createdAt), desc(answerMemory.id))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map((r) => ({
    ...toEntry(r),
    counterpartyId: r.counterpartyId as CounterpartyId,
    questionId: r.questionId,
    answerType: r.answerType,
    fingerprint: r.fingerprint,
    fpVersion: r.fpVersion,
  }));
}

/** The counterparty of the RFI's payment; null for an orphan RFI or a payment without one. */
export async function rfiCounterpartyId(ctx: RepoCtx, rfi: Rfi): Promise<CounterpartyId | null> {
  if (!rfi.paymentId) return null;
  return (await getPayment(ctx, rfi.paymentId))?.counterpartyId ?? null;
}

/** The text a question is fingerprinted on: the English title and description, else Chinese. */
export const questionTextOf = (q: Pick<RfiQuestionRow, "title" | "description">): string =>
  approvalQuestionText(q.title, q.description);

/**
 * The newest approved answer for an identical question of this counterparty, else null. Any difference in
 * the normalised text, the answer type, the counterparty or the business gives no match.
 */
export async function findReusable(
  ctx: RepoCtx,
  counterpartyId: CounterpartyId,
  questionText: string,
  answerType: string,
): Promise<MemoryEntry | null> {
  const [row] = await ctx.db
    .select()
    .from(answerMemory)
    .where(
      and(
        eq(answerMemory.businessId, ctx.businessId),
        eq(answerMemory.counterpartyId, counterpartyId),
        eq(answerMemory.fingerprint, fingerprint({ counterpartyId, questionText, answerType })),
        eq(answerMemory.fpVersion, FP_VERSION),
      ),
    )
    .orderBy(desc(answerMemory.approvedAt), desc(answerMemory.createdAt), desc(answerMemory.id))
    .limit(1);
  return row ? toEntry(row) : null;
}

/** Matches for the questions of one RFI round, keyed by the Carnet question id. */
export async function findReusableForRound(
  ctx: RepoCtx,
  rfi: Rfi,
  round: number,
): Promise<{
  questions: RfiQuestionRow[];
  matches: Map<string, MemoryEntry>;
  counterpartyId: CounterpartyId | null;
}> {
  const questions = (await listRfiQuestions(ctx, rfi.id, round)).filter((q) => q.needsDrafting);
  const counterpartyId = await rfiCounterpartyId(ctx, rfi);
  const matches = new Map<string, MemoryEntry>();
  if (!counterpartyId) return { questions, matches, counterpartyId };
  for (const q of questions) {
    const found = await findReusable(ctx, counterpartyId, questionTextOf(q), q.answerType);
    if (found) matches.set(q.id, found);
  }
  return { questions, matches, counterpartyId };
}

export type RecordOutcome =
  | { readonly recorded: number; readonly skipped: null }
  | { readonly recorded: 0; readonly skipped: string };

const skip = (reason: string): RecordOutcome => ({ recorded: 0, skipped: reason });

/** `<document_facts.id>#<index>` -> the fact it names, in the shape memory remembers. */
async function resolveCitation(
  ctx: RepoCtx,
  factVersionId: string,
): Promise<MemoryCitation | null> {
  const [id, index] = factVersionId.split("#");
  const at = Number(index);
  if (!id || !Number.isInteger(at) || at < 0) return null;
  const [row] = await ctx.db
    .select({ documentId: documentFacts.documentId, facts: documentFacts.facts })
    .from(documentFacts)
    .where(and(eq(documentFacts.businessId, ctx.businessId), eq(documentFacts.id, id)));
  const fact = (row?.facts as { key?: string; quote?: string }[] | undefined)?.[at];
  if (!row || !fact?.key || typeof fact.quote !== "string") return null;
  return {
    fact_version_id: factVersionId,
    quote: fact.quote,
    document_id: row.documentId,
    key: fact.key,
  };
}

/**
 * The `answer.submitted` hook. Writes one row per answered question of the approval, and only when the
 * approval is CONSUMED and its respond attempt is CONFIRMED (or, with no attempt given, the RFI is
 * ANSWERED). Never from a draft or a PENDING, APPROVED, REJECTED or EXPIRED approval. Idempotent: a
 * redelivered event writes nothing twice (unique per approval and question). Call inside the
 * transaction that also writes the audit entry.
 */
export async function recordApprovedAnswers(
  ctx: RepoCtx,
  input: { rfiId: RfiId; approvalId: ApprovalId; attemptId?: AttemptId | null },
): Promise<RecordOutcome> {
  const approval = await getApproval(ctx, input.approvalId);
  if (!approval || approval.kind !== "rfi_answer" || approval.subjectRef !== input.rfiId) {
    return skip("APPROVAL_NOT_FOUND");
  }
  if (approval.status !== "CONSUMED" || !approval.consumedAt) return skip("APPROVAL_NOT_CONSUMED");
  const rfi = await getRfi(ctx, input.rfiId);
  if (!rfi) return skip("RFI_NOT_FOUND");
  if (input.attemptId) {
    const attempt = await getAttempt(ctx, input.attemptId);
    if (
      !attempt ||
      attempt.kind !== "respond" ||
      attempt.refId !== rfi.id ||
      attempt.status !== "CONFIRMED"
    ) {
      return skip("ATTEMPT_NOT_CONFIRMED");
    }
  } else if (rfi.state !== "ANSWERED") {
    return skip("RFI_NOT_ANSWERED");
  }
  const snapshot = approval.shownSnapshot as {
    version?: number;
    subject?: RfiAnswerSubject;
  } | null;
  const subject = snapshot?.version === 1 ? snapshot.subject : undefined;
  if (!subject || subject.rfiId !== rfi.id) return skip("SNAPSHOT_UNREADABLE");
  const counterpartyId = await rfiCounterpartyId(ctx, rfi);
  if (!counterpartyId) return skip("NO_COUNTERPARTY");
  const draft = UUID.test(subject.draftId) ? await getDraft(ctx, subject.draftId) : null;
  const round = draft?.round ?? rfi.round;
  const byAirwallexId = new Map(
    (await listRfiQuestions(ctx, rfi.id, round)).map((q) => [q.airwallexQuestionId, q]),
  );

  let recorded = 0;
  for (const answer of subject.answers as readonly ApprovalAnswer[]) {
    const question = byAirwallexId.get(answer.questionId);
    if (!question) continue;
    const citations: MemoryCitation[] = [];
    for (const id of answer.factVersionIds) {
      const c = await resolveCitation(ctx, id);
      if (c) citations.push(c);
    }
    // A cited fact that cannot be found again would turn a cited answer into an uncited one: remember nothing.
    if (citations.length !== answer.factVersionIds.length) continue;
    const inserted = await ctx.db
      .insert(answerMemory)
      .values({
        businessId: ctx.businessId,
        counterpartyId,
        fingerprint: fingerprint({
          counterpartyId,
          questionText: questionTextOf(question),
          answerType: question.answerType,
        }),
        fpVersion: FP_VERSION,
        answerType: question.answerType,
        questionId: question.id,
        answerText: answer.text,
        citations,
        attachments: answer.attachments.map((a) => ({
          document_id: a.documentId,
          sha256: a.sha256,
        })),
        sourceApprovalId: approval.id,
        approvedAt: approval.consumedAt,
      })
      .onConflictDoNothing()
      .returning({ id: answerMemory.id });
    recorded += inserted.length;
  }
  return { recorded, skipped: null };
}
