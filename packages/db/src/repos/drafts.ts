// Drafts repository (M2-05, ADR 0010). Drafts and their answers are immutable: `insertDraft` is the only
// writer, there is no update or delete function, the app role has no UPDATE or DELETE on either table, and
// a trigger refuses both for every role (migration 0011). An owner edit and a re-draft insert a NEW draft.
//
// Call `insertDraft` inside the transaction that also moves the RFI and publishes `draft.ready` /
// `draft.needs_owner` (ADR 0005). Tenant repository: `ctx` first, every statement scoped by
// `ctx.businessId`.
import {
  type AnswerVerdict,
  type BlockingQuestion,
  type DocumentId,
  type DraftAnswerInput,
  type DraftCitation,
  type ExtractedFact,
  needsOwner,
  type RfiId,
  rollupDraft,
  type SuppliedDocument,
  type SuppliedFact,
  usableFacts,
  verifyAnswer,
} from "@carnet/domain";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { translateDbError, UniqueViolationError } from "../errors";
import { draftAnswers, drafts } from "../schema/index";
import type { RepoCtx } from "./context";
import { listDocuments } from "./documents";
import { getLatestFacts } from "./document-facts";
import { listRfiQuestions } from "./rfis";

export type DraftOrigin = "model" | "owner" | "system";
export type DraftState = "DRAFT_READY" | "NEEDS_OWNER";

export interface StoredDraft {
  readonly id: string;
  readonly rfiId: RfiId;
  readonly round: number;
  readonly parentDraftId: string | null;
  readonly origin: DraftOrigin;
  readonly draftKey: string;
  readonly promptVersion: string | null;
  readonly model: string | null;
  readonly inputHash: string | null;
  readonly injectionFlags: readonly { kind: string; rule: string; match: string }[];
  readonly agentRunId: string | null;
  readonly state: DraftState;
  readonly blocking: readonly BlockingQuestion[];
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export interface StoredDraftAnswer {
  readonly id: string;
  readonly draftId: string;
  readonly questionId: string;
  readonly text: string;
  readonly citations: readonly DraftCitation[];
  readonly documentIds: readonly string[];
  readonly status: AnswerVerdict["status"];
  readonly reasonCode: string | null;
  readonly verifierResult: AnswerVerdict;
  readonly createdAt: Date;
}

export interface NewDraftAnswer {
  readonly questionId: string;
  readonly text: string;
  readonly citations: readonly DraftCitation[];
  readonly documentIds: readonly string[];
  readonly verdict: AnswerVerdict;
}

export interface NewDraft {
  readonly rfiId: RfiId;
  readonly round: number;
  readonly parentDraftId?: string | null;
  readonly origin: DraftOrigin;
  readonly draftKey: string;
  readonly promptVersion?: string | null;
  readonly model?: string | null;
  readonly inputHash?: string | null;
  readonly injectionFlags?: readonly { kind: string; rule: string; match: string }[];
  readonly agentRunId?: string | null;
  readonly createdBy?: string | null;
  readonly answers: readonly NewDraftAnswer[];
}

type DraftRow = typeof drafts.$inferSelect;
type AnswerRow = typeof draftAnswers.$inferSelect;

function toDraft(row: DraftRow): StoredDraft {
  return {
    id: row.id,
    rfiId: row.rfiId as RfiId,
    round: row.round,
    parentDraftId: row.parentDraftId,
    origin: row.origin as DraftOrigin, // CHECK drafts_origin_check
    draftKey: row.draftKey,
    promptVersion: row.promptVersion,
    model: row.model,
    inputHash: row.inputHash,
    injectionFlags: row.injectionFlags as StoredDraft["injectionFlags"],
    agentRunId: row.agentRunId,
    state: row.state as DraftState, // CHECK drafts_state_check
    blocking: row.blocking as StoredDraft["blocking"],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

function toAnswer(row: AnswerRow): StoredDraftAnswer {
  return {
    id: row.id,
    draftId: row.draftId,
    questionId: row.questionId,
    text: row.text,
    citations: row.citations as StoredDraftAnswer["citations"],
    documentIds: row.documentIds,
    status: row.status as StoredDraftAnswer["status"], // CHECK draft_answers_status_check
    reasonCode: row.reasonCode,
    verifierResult: row.verifierResult as AnswerVerdict,
    createdAt: row.createdAt,
  };
}

/** Inserts a draft with its answers. A second call with the same key returns the stored draft. */
export async function insertDraft(
  ctx: RepoCtx,
  input: NewDraft,
): Promise<{ draft: StoredDraft; inserted: boolean }> {
  const existing = await getDraftByKey(ctx, input.rfiId, input.round, input.draftKey);
  if (existing) return { draft: existing, inserted: false };
  const rollup = rollupDraft(
    input.answers.map((a) => ({ question_id: a.questionId, verdict: a.verdict })),
  );
  try {
    const [row] = await ctx.db
      .insert(drafts)
      .values({
        businessId: ctx.businessId,
        rfiId: input.rfiId,
        round: input.round,
        parentDraftId: input.parentDraftId ?? null,
        origin: input.origin,
        draftKey: input.draftKey,
        promptVersion: input.promptVersion ?? null,
        model: input.model ?? null,
        inputHash: input.inputHash ?? null,
        injectionFlags: [...(input.injectionFlags ?? [])],
        agentRunId: input.agentRunId ?? null,
        state: rollup.state,
        blocking: [...rollup.blocking],
        createdBy: input.createdBy ?? null,
      })
      .returning();
    if (!row) throw new Error("drafts insert returned no row");
    if (input.answers.length > 0) {
      await ctx.db.insert(draftAnswers).values(
        input.answers.map((a) => ({
          businessId: ctx.businessId,
          draftId: row.id,
          questionId: a.questionId,
          text: a.text,
          citations: [...a.citations],
          documentIds: [...a.documentIds],
          status: a.verdict.status,
          reasonCode: a.verdict.reason,
          verifierResult: a.verdict,
        })),
      );
    }
    return { draft: toDraft(row), inserted: true };
  } catch (error) {
    const translated = translateDbError(error);
    if (
      translated instanceof UniqueViolationError &&
      translated.constraint === "drafts_rfi_round_key_key"
    ) {
      const raced = await getDraftByKey(ctx, input.rfiId, input.round, input.draftKey);
      if (raced) return { draft: raced, inserted: false };
    }
    throw translated;
  }
}

async function getDraftByKey(
  ctx: RepoCtx,
  rfiId: RfiId,
  round: number,
  draftKey: string,
): Promise<StoredDraft | null> {
  const [row] = await ctx.db
    .select()
    .from(drafts)
    .where(
      and(
        eq(drafts.businessId, ctx.businessId),
        eq(drafts.rfiId, rfiId),
        eq(drafts.round, round),
        eq(drafts.draftKey, draftKey),
      ),
    );
  return row ? toDraft(row) : null;
}

export async function getDraft(ctx: RepoCtx, id: string): Promise<StoredDraft | null> {
  const [row] = await ctx.db
    .select()
    .from(drafts)
    .where(and(eq(drafts.businessId, ctx.businessId), eq(drafts.id, id)));
  return row ? toDraft(row) : null;
}

/** Every draft of the RFI (a round, or all rounds), newest first. */
export async function listDrafts(
  ctx: RepoCtx,
  rfiId: RfiId,
  round?: number,
): Promise<StoredDraft[]> {
  const conds = [eq(drafts.businessId, ctx.businessId), eq(drafts.rfiId, rfiId)];
  if (round !== undefined) conds.push(eq(drafts.round, round));
  const rows = await ctx.db
    .select()
    .from(drafts)
    .where(and(...conds))
    .orderBy(desc(drafts.createdAt), desc(drafts.id));
  return rows.map(toDraft);
}

export async function getLatestDraft(
  ctx: RepoCtx,
  rfiId: RfiId,
  round: number,
): Promise<StoredDraft | null> {
  const [row] = await ctx.db
    .select()
    .from(drafts)
    .where(
      and(eq(drafts.businessId, ctx.businessId), eq(drafts.rfiId, rfiId), eq(drafts.round, round)),
    )
    .orderBy(desc(drafts.createdAt), desc(drafts.id))
    .limit(1);
  return row ? toDraft(row) : null;
}

export async function listDraftAnswers(
  ctx: RepoCtx,
  draftId: string,
): Promise<StoredDraftAnswer[]> {
  const rows = await ctx.db
    .select()
    .from(draftAnswers)
    .where(and(eq(draftAnswers.businessId, ctx.businessId), eq(draftAnswers.draftId, draftId)))
    .orderBy(asc(draftAnswers.createdAt), asc(draftAnswers.id));
  return rows.map(toAnswer);
}

// ---------------------------------------------------------------------------------------------
// Evidence the draft call and the verifier use

/** Documents the answer may use, with the facts of their latest version that are usable as evidence. */
export interface DraftingEvidence {
  readonly facts: readonly SuppliedFact[];
  readonly documents: readonly SuppliedDocument[];
}

/** The most documents offered to one draft call (newest first); keeps the prompt bounded. */
export const MAX_DRAFTING_DOCUMENTS = 40;

/**
 * The business's documents and their usable facts (the latest version only: verified against the
 * document, or owner-confirmed). A fact's id is `<facts version id>#<index in that version>`. Until
 * payments carry attached documents (M2-03 evidence links) every document of the business is offered.
 */
export async function loadDraftingEvidence(ctx: RepoCtx): Promise<DraftingEvidence> {
  const docs = await listDocuments(ctx, MAX_DRAFTING_DOCUMENTS);
  const facts: SuppliedFact[] = [];
  const documents: SuppliedDocument[] = [];
  for (const doc of docs) {
    const latest = await getLatestFacts(ctx, doc.id as DocumentId);
    const usable = new Set<ExtractedFact>(latest ? usableFacts(latest) : []);
    documents.push({
      id: doc.id,
      kind: doc.kind,
      name: doc.filename,
      hasUsableFacts: usable.size > 0,
    });
    if (!latest) continue;
    latest.facts.forEach((f, index) => {
      if (!usable.has(f)) return;
      facts.push({
        id: `${latest.id}#${index}`,
        documentId: doc.id,
        key: f.key,
        value: f.value,
        parsed: f.parsed,
        quote: f.quote,
        page: f.page,
      });
    });
  }
  return { facts, documents };
}

/** One answer the owner wrote or edited. */
export interface OwnerAnswerInput {
  readonly questionId: string;
  readonly text: string;
  readonly citations?: readonly DraftCitation[];
  readonly documentIds?: readonly string[];
  /** Explicitly mark text that cites nothing; it is stored as OWNER_AUTHORED (shown as unverified). */
  readonly ownerAuthored?: boolean;
}

/**
 * An owner edit (or the owner writing answers after NEEDS_OWNER): inserts a NEW draft, a child of
 * `parentDraftId`, whose answers go through the same verifier as a model draft. The parent stays.
 * Questions the owner did not answer are stored as NEEDS_OWNER (ANSWER_MISSING). Returns null when the
 * RFI has no questions in `round`. Idempotent per `draftKey`.
 */
export async function createOwnerDraft(
  ctx: RepoCtx,
  input: {
    rfiId: RfiId;
    round: number;
    parentDraftId: string | null;
    draftKey: string;
    userId: string;
    answers: readonly OwnerAnswerInput[];
  },
): Promise<{ draft: StoredDraft; inserted: boolean } | null> {
  const questions = (await listRfiQuestions(ctx, input.rfiId, input.round)).filter(
    (q) => q.needsDrafting,
  );
  if (questions.length === 0) return null;
  const evidence = await loadDraftingEvidence(ctx);
  const rows: NewDraftAnswer[] = questions.map((q) => {
    const given = input.answers.find((a) => a.questionId === q.id);
    if (!given) {
      return {
        questionId: q.id,
        text: "",
        citations: [],
        documentIds: [],
        verdict: needsOwner("ANSWER_MISSING"),
      };
    }
    const answer: DraftAnswerInput = {
      question_id: q.id,
      status: "answered",
      text: given.text,
      citations: given.citations ?? [],
      document_ids: given.documentIds ?? [],
    };
    return {
      questionId: q.id,
      text: given.text,
      citations: answer.citations,
      documentIds: answer.document_ids,
      verdict: verifyAnswer({ id: q.id, answerType: q.answerType }, answer, evidence, {
        ownerAuthored: given.ownerAuthored === true,
      }),
    };
  });
  return insertDraft(ctx, {
    rfiId: input.rfiId,
    round: input.round,
    parentDraftId: input.parentDraftId,
    origin: "owner",
    draftKey: input.draftKey,
    createdBy: input.userId,
    answers: rows,
  });
}

/** Answers for the given drafts, grouped by draft id (the approval screen lists a draft's history). */
export async function listAnswersForDrafts(
  ctx: RepoCtx,
  draftIds: readonly string[],
): Promise<Map<string, StoredDraftAnswer[]>> {
  const out = new Map<string, StoredDraftAnswer[]>();
  if (draftIds.length === 0) return out;
  const rows = await ctx.db
    .select()
    .from(draftAnswers)
    .where(
      and(
        eq(draftAnswers.businessId, ctx.businessId),
        inArray(draftAnswers.draftId, [...draftIds]),
      ),
    )
    .orderBy(asc(draftAnswers.createdAt), asc(draftAnswers.id));
  for (const row of rows) {
    const list = out.get(row.draftId) ?? [];
    list.push(toAnswer(row));
    out.set(row.draftId, list);
  }
  return out;
}
