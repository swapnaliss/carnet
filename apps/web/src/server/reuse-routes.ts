// POST /api/v1/rfis/{id}/reuse (M2-06): one-click reuse of earlier approved answers. For every question
// of the RFI's current round that has an identical, approved answer for the same counterparty, a new
// draft is stored with that answer pre-filled; the answer is verified against the CURRENT facts and
// documents (a changed fact or document makes it NEEDS_OWNER, `REUSE_STALE`). No model is called. Every
// other question keeps the answer of the draft it replaces. The result is a new draft (the previous one
// stays) that still needs a new, bound approval (M2-07). Each reuse writes an audit entry.
import { resolveReuse } from "@carnet/agent";
import {
  appendAudit,
  findReusableForRound,
  getLatestDraft,
  getRfi,
  insertDraft,
  listDocuments,
  listDraftAnswers,
  loadDraftingEvidence,
  MAX_DRAFTING_DOCUMENTS,
  type NewDraftAnswer,
  repoCtx,
  type StoredDraft,
  type StoredDraftAnswer,
  withTransaction,
} from "@carnet/db";
import { needsOwner, RfiIdSchema } from "@carnet/domain";
import { z } from "zod";
import type { AuthRule, RouteSpec } from "../lib/define-route";
import { HttpProblem, notFound } from "../lib/errors";

type Schema = z.ZodType | undefined;
const routeSpec = <A extends AuthRule, B extends Schema, Q extends Schema, P extends Schema>(
  spec: RouteSpec<A, B, Q, P>,
) => spec;

const REUSABLE_STATES = ["DRAFT_READY", "NEEDS_OWNER"] as const;

export function answerJson(a: StoredDraftAnswer) {
  return {
    question_id: a.questionId,
    text: a.text,
    citations: a.citations,
    document_ids: a.documentIds,
    status: a.status,
    reason_code: a.reasonCode,
    explanation: a.verifierResult.explanation,
    // "Same as approved on <date>" (M2-08): present when the answer is the remembered, approved one.
    reuse: a.reused
      ? {
          reused: true,
          approved_on: a.reused.approved_on,
          source_approval_id: a.reused.source_approval_id,
        }
      : null,
  };
}

export function draftJson(d: StoredDraft, answers: readonly StoredDraftAnswer[]) {
  return {
    id: d.id,
    rfi_id: d.rfiId,
    round: d.round,
    parent_draft_id: d.parentDraftId,
    origin: d.origin,
    state: d.state,
    blocking: d.blocking,
    created_at: d.createdAt.toISOString(),
    answers: answers.map(answerJson),
  };
}

export const rfiReuseSpec = routeSpec({
  method: "POST",
  auth: { roles: ["owner", "approver"] as const },
  params: z.strictObject({ id: RfiIdSchema }),
  handler: async ({ ctx, repo, params }) =>
    withTransaction(repo.db, async (tx) => {
      const rc = repoCtx(tx, repo.businessId);
      const rfi = await getRfi(rc, params.id);
      if (!rfi) throw notFound();
      const parent = await getLatestDraft(rc, rfi.id, rfi.round);
      if (!(REUSABLE_STATES as readonly string[]).includes(rfi.state) || !parent) {
        throw new HttpProblem(
          "PRECONDITION_FAILED",
          "Reuse needs a finished draft that is not yet approved. Nothing was reused.",
          { details: { reason: "NOT_REUSABLE_STATE", state: rfi.state } },
        );
      }
      // A second click: the latest draft already is the reuse draft. Nothing is written or audited twice.
      if (parent.draftKey.startsWith("reuse:")) {
        return Response.json({
          reused: true,
          draft: draftJson(parent, await listDraftAnswers(rc, parent.id)),
        });
      }
      const { questions, matches } = await findReusableForRound(rc, rfi, rfi.round);
      const evidence = await loadDraftingEvidence(rc);
      const docs = await listDocuments(rc, MAX_DRAFTING_DOCUMENTS);
      const results = resolveReuse(
        questions.map((q) => ({ id: q.id, answerType: q.answerType })),
        matches,
        { ...evidence, documentHashes: new Map(docs.map((d) => [d.id, d.sha256])) },
      );
      if (results.every((r) => r.kind === "none")) {
        return Response.json({ reused: false, draft: null });
      }

      const previous = new Map(
        (await listDraftAnswers(rc, parent.id)).map((a) => [a.questionId, a]),
      );
      const answers: NewDraftAnswer[] = results.map((r) => {
        if (r.kind === "reused") {
          return {
            questionId: r.question_id,
            text: r.answer.text,
            citations: r.answer.citations,
            documentIds: r.answer.document_ids,
            verdict: r.verdict,
            reused: r.provenance,
          };
        }
        if (r.kind === "stale") {
          // Nothing ungrounded is stored as an answer: the reason stays, the remembered text does not.
          return {
            questionId: r.question_id,
            text: "",
            citations: [],
            documentIds: [],
            verdict: r.verdict,
            reused: r.provenance,
          };
        }
        const kept = previous.get(r.question_id);
        return kept
          ? {
              questionId: r.question_id,
              text: kept.text,
              citations: kept.citations,
              documentIds: kept.documentIds,
              verdict: kept.verifierResult,
              reused: kept.reused,
            }
          : {
              questionId: r.question_id,
              text: "",
              citations: [],
              documentIds: [],
              verdict: needsOwner("ANSWER_MISSING"),
            };
      });

      const { draft, inserted } = await insertDraft(rc, {
        rfiId: rfi.id,
        round: rfi.round,
        parentDraftId: parent.id,
        origin: "owner",
        draftKey: `reuse:r${rfi.round}:${parent.id}`,
        createdBy: ctx.userId,
        answers,
      });
      if (inserted) {
        for (const r of results) {
          if (r.kind === "none") continue;
          await appendAudit(rc, {
            actorType: "user",
            actorId: ctx.userId,
            action: r.kind === "reused" ? "answer.reused" : "answer.reuse_stale",
            subject: `rfi:${rfi.id}`,
            data: {
              draftId: draft.id,
              questionId: r.question_id,
              memoryId: r.provenance.memory_id,
              sourceApprovalId: r.provenance.source_approval_id,
              approvedOn: r.provenance.approved_on,
              ...(r.kind === "stale" ? { reason: r.verdict.reason, detail: r.verdict.detail } : {}),
            },
          });
        }
      }
      const stored = (await listDraftAnswers(rc, draft.id)).sort(
        (a, b) => order(questions, a.questionId) - order(questions, b.questionId),
      );
      return Response.json(
        { reused: true, draft: draftJson(draft, stored) },
        { status: inserted ? 201 : 200 },
      );
    }),
});

const order = (qs: readonly { id: string }[], id: string): number =>
  qs.findIndex((q) => q.id === id);
