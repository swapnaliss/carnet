// The hold screen's read model (M2-08). One GET returns everything the screen shows: the RFI, its
// held payment, the questions of the active round with the latest draft's answers, every citation
// resolved to the verbatim quote, document and page it came from, the approval and its execution
// attempt. It only reads; nothing here changes an RFI, a draft or a payment. The money status shown is
// `project(transferStatus, rfiHolds)`: the RFI never writes it (CLAUDE.md domain rules).
//
//   GET  /api/v1/rfis/{id}/hold     any session   → HoldView  (the 3 s poll target)
//   POST /api/v1/rfis/{id}/drafts   owner/approver → 201 { draft }  (an owner edit: a NEW draft, the
//                                    same verifier as a model draft, no model call)
import { createHash } from "node:crypto";
import {
  appendAudit,
  createOwnerDraft,
  type DocumentRecord,
  DuplicateIdempotencyKeyError,
  effectiveApprovalStatus,
  getCounterparty,
  getFactsVersionById,
  getIdempotencyRecord,
  getLatestDraft,
  getPayment,
  getRfi,
  getSystemFlags,
  listApprovalsForSubject,
  listAttemptsForRefs,
  listDocuments,
  listDraftAnswers,
  listRfiQuestions,
  type RepoCtx,
  type Rfi,
  repoCtx,
  type StoredDraft,
  type StoredDraftAnswer,
  saveIdempotencyRecord,
  withTransaction,
} from "@carnet/db";
import {
  DRAFT_REASON_EXPLANATIONS,
  type DraftReasonCode,
  IdempotencyKeySchema,
  type MoneyWire,
  project,
  RfiIdSchema,
  rfiHolds,
  toMoneyWire,
} from "@carnet/domain";
import { z } from "zod";
import type { AuthRule, RouteSpec } from "../lib/define-route";
import { conflict, HttpProblem, notFound } from "../lib/errors";
import { approvalTtlMinutes } from "./approvals";
import { rfiJson } from "./rfis";

type Schema = z.ZodType | undefined;
const routeSpec = <A extends AuthRule, B extends Schema, Q extends Schema, P extends Schema>(
  spec: RouteSpec<A, B, Q, P>,
) => spec;

export interface DocumentDto {
  readonly id: string;
  readonly filename: string;
  readonly kind: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
}

export interface CitationDto {
  readonly fact_version_id: string;
  readonly document: DocumentDto;
  readonly key: string;
  readonly value: string;
  /** The verbatim quote from the document's text layer. */
  readonly quote: string;
  readonly page: number;
  readonly verification: "quote_verified" | "owner_confirmed";
}

export interface AnswerDto {
  readonly status: "VERIFIED" | "NEEDS_OWNER" | "OWNER_AUTHORED";
  readonly reason_code: string | null;
  readonly explanation: string | null;
  readonly detail: string | null;
  readonly text: string;
  readonly citations: readonly CitationDto[];
  /** Citations the draft named that could not be resolved to a stored fact (the source did not load). */
  readonly unresolved_citations: readonly string[];
  readonly documents: readonly DocumentDto[];
}

export interface QuestionDto {
  readonly id: string;
  readonly airwallex_question_id: string;
  readonly position: number;
  readonly title: string;
  readonly description: string;
  readonly answer_type: string;
  readonly reopened: boolean;
  readonly answer: AnswerDto | null;
}

export interface HoldView {
  readonly server_time: string;
  readonly role: string;
  readonly rfi: ReturnType<typeof rfiJson>;
  readonly payment: {
    readonly id: string;
    readonly counterparty: string | null;
    readonly reference: string;
    readonly amount: MoneyWire;
    readonly transfer_status: string | null;
    readonly view: string | null;
    readonly held: boolean;
  } | null;
  readonly questions: readonly QuestionDto[];
  readonly draft: {
    readonly id: string;
    readonly state: string;
    readonly origin: string;
    readonly prompt_version: string | null;
    readonly created_at: string;
    readonly injection_flagged: boolean;
  } | null;
  readonly approval: {
    readonly id: string;
    readonly status: string;
    readonly hash: string;
    readonly expires_at: string;
    readonly consumed_at: string | null;
    readonly created_at: string;
  } | null;
  readonly attempt: {
    readonly status: string;
    readonly request_id: string;
    readonly message: string | null;
  } | null;
  readonly execution_enabled: boolean;
  readonly approval_ttl_minutes: number;
  /** Documents an owner can attach to an ATTACHMENT question (newest first). */
  readonly documents: readonly DocumentDto[];
}

const documentDto = (d: DocumentRecord): DocumentDto => ({
  id: d.id,
  filename: d.filename,
  kind: d.kind,
  mime: d.mime,
  size: d.size,
  sha256: d.sha256,
});

const english = (t: { en: string | null; zh: string | null }): string => t.en ?? t.zh ?? "";

async function resolveAnswer(
  rc: RepoCtx,
  answer: StoredDraftAnswer,
  docs: Map<string, DocumentRecord>,
  versions: Map<string, Awaited<ReturnType<typeof getFactsVersionById>>>,
): Promise<AnswerDto> {
  const citations: CitationDto[] = [];
  const unresolved: string[] = [];
  for (const c of answer.citations) {
    const [versionId, indexText] = c.fact_version_id.split("#");
    const index = Number(indexText);
    if (!versionId || !Number.isInteger(index)) {
      unresolved.push(c.fact_version_id);
      continue;
    }
    if (!versions.has(versionId)) versions.set(versionId, await getFactsVersionById(rc, versionId));
    const version = versions.get(versionId);
    const fact = version?.facts[index];
    const doc = version ? docs.get(version.documentId) : undefined;
    if (!version || !fact || !doc) {
      unresolved.push(c.fact_version_id);
      continue;
    }
    citations.push({
      fact_version_id: c.fact_version_id,
      document: documentDto(doc),
      key: fact.key,
      value: fact.value,
      quote: fact.quote,
      page: fact.page,
      verification:
        fact.quote_verified && !fact.needs_confirmation ? "quote_verified" : "owner_confirmed",
    });
  }
  const verdict = answer.verifierResult;
  const reason = answer.reasonCode as DraftReasonCode | null;
  return {
    status: answer.status,
    reason_code: answer.reasonCode,
    explanation:
      verdict.explanation ?? (reason ? (DRAFT_REASON_EXPLANATIONS[reason] ?? null) : null),
    detail: verdict.detail,
    text: answer.text,
    citations,
    unresolved_citations: unresolved,
    documents: answer.documentIds
      .map((id) => docs.get(id))
      .filter((d): d is DocumentRecord => d !== undefined)
      .map(documentDto),
  };
}

export async function loadHoldView(
  repo: RepoCtx,
  rfi: Rfi,
  role: string,
  now = new Date(),
): Promise<HoldView> {
  const [questionRows, draft, approvals, flags, allDocs] = await Promise.all([
    listRfiQuestions(repo, rfi.id, rfi.round),
    getLatestDraft(repo, rfi.id, rfi.round),
    listApprovalsForSubject(repo, "rfi_answer", rfi.id),
    getSystemFlags(repo.db).then(
      (f) => f.executionEnabled,
      () => false, // an unreadable kill switch counts as off, as the approve path does
    ),
    listDocuments(repo, 100),
  ]);
  const docs = new Map(allDocs.map((d) => [d.id as string, d]));
  const answers = draft ? await listDraftAnswers(repo, draft.id) : [];
  const versions = new Map<string, Awaited<ReturnType<typeof getFactsVersionById>>>();
  const resolved = new Map<string, AnswerDto>();
  for (const a of answers) resolved.set(a.questionId, await resolveAnswer(repo, a, docs, versions));

  const payment = rfi.paymentId ? await getPayment(repo, rfi.paymentId) : null;
  const counterparty = payment?.counterpartyId
    ? await getCounterparty(repo, payment.counterpartyId)
    : null;
  const projection = payment?.transferStatus
    ? project(payment.transferStatus, rfiHolds(rfi.state))
    : null;

  const approval = approvals[0] ?? null;
  const attempts = approval
    ? (await listAttemptsForRefs(repo, "respond", [rfi.id])).at(-1) // oldest first: last is newest
    : undefined;
  const lastError = (() => {
    const r = attempts?.response;
    if (typeof r !== "object" || r === null) return null;
    const e = (r as Record<string, unknown>).error as Record<string, unknown> | undefined;
    return e && typeof e.message === "string" ? e.message : null;
  })();

  return {
    server_time: now.toISOString(),
    role,
    rfi: rfiJson(rfi),
    payment: payment
      ? {
          id: payment.id,
          counterparty: counterparty?.name ?? null,
          reference: payment.reference,
          amount: toMoneyWire(payment.amount),
          transfer_status: payment.transferStatus,
          view: projection?.view ?? null,
          held: projection?.held ?? false,
        }
      : null,
    questions: questionRows
      .sort((a, b) => a.position - b.position)
      .map((q) => ({
        id: q.id,
        airwallex_question_id: q.airwallexQuestionId,
        position: q.position,
        title: english(q.title),
        description: english(q.description),
        answer_type: q.answerType,
        reopened: q.reopened,
        answer: resolved.get(q.id) ?? null,
      })),
    draft: draft ? draftDto(draft) : null,
    approval: approval
      ? {
          id: approval.id,
          status: effectiveApprovalStatus(approval, now),
          hash: approval.hash,
          expires_at: approval.expiresAt.toISOString(),
          consumed_at: approval.consumedAt?.toISOString() ?? null,
          created_at: approval.createdAt.toISOString(),
        }
      : null,
    attempt: attempts
      ? { status: attempts.status, request_id: attempts.requestId, message: lastError }
      : null,
    execution_enabled: flags,
    approval_ttl_minutes: approvalTtlMinutes(),
    documents: role === "viewer" ? [] : allDocs.map(documentDto),
  };
}

function draftDto(d: StoredDraft): NonNullable<HoldView["draft"]> {
  return {
    id: d.id,
    state: d.state,
    origin: d.origin,
    prompt_version: d.promptVersion,
    created_at: d.createdAt.toISOString(),
    injection_flagged: d.injectionFlags.length > 0,
  };
}

const RfiParams = z.strictObject({ id: RfiIdSchema });

export const holdViewSpec = routeSpec({
  method: "GET",
  auth: "session",
  params: RfiParams,
  handler: async ({ ctx, repo, params }) => {
    const rfi = await getRfi(repo, params.id);
    if (!rfi) throw notFound();
    return Response.json(await loadHoldView(repo, rfi, ctx.role), {
      headers: { "cache-control": "no-store" },
    });
  },
});

// ---------------------------------------------------------------------------------------------
// Owner edit: a new draft through the M2-05 path.

export const OWNER_DRAFT_ENDPOINT = (rfiId: string) => `POST /api/v1/rfis/${rfiId}/drafts`;

export const OwnerDraftBodySchema = z.strictObject({
  /** The draft the owner was looking at; a newer one is a 409. */
  parent_draft_id: z.string().min(1).max(128).nullable(),
  answers: z
    .array(
      z.strictObject({
        question_id: z.string().min(1).max(128),
        text: z.string().max(10_000).default(""),
        document_ids: z.array(z.string().min(1).max(128)).max(10).default([]),
        fact_version_ids: z.array(z.string().min(1).max(128)).max(50).default([]),
        /** The text cites nothing and is the owner's own statement: stored OWNER_AUTHORED. */
        owner_authored: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(50),
});

export const ownerDraftSpec = routeSpec({
  method: "POST",
  auth: { roles: ["owner", "approver"] as const },
  params: RfiParams,
  body: OwnerDraftBodySchema,
  maxBodyBytes: 256 * 1024,
  rateLimit: { name: "approval", by: "user" },
  handler: async ({ req, ctx, repo, params, body }) => {
    const key = IdempotencyKeySchema.safeParse(req.headers.get("idempotency-key") ?? "");
    if (!key.success) {
      throw new HttpProblem(
        "VALIDATION_FAILED",
        "Send an Idempotency-Key header (8 to 128 visible characters). Nothing was saved.",
      );
    }
    const endpoint = OWNER_DRAFT_ENDPOINT(params.id);
    const existing = await getIdempotencyRecord(repo, endpoint, key.data);
    if (existing) {
      return Response.json(existing.response, { status: existing.responseStatus });
    }
    try {
      return await withTransaction(repo.db, async (tx) => {
        const rc = repoCtx(tx, repo.businessId);
        const rfi = await getRfi(rc, params.id);
        if (!rfi) throw notFound();
        if (rfi.state !== "DRAFT_READY" && rfi.state !== "NEEDS_OWNER") {
          throw conflict(
            `This RFI is ${rfi.state}, so its answers cannot be edited. Reload to see where it stands.`,
          );
        }
        const latest = await getLatestDraft(rc, rfi.id, rfi.round);
        if ((latest?.id ?? null) !== body.parent_draft_id) {
          throw conflict("A newer draft exists for this RFI. Reload, then edit that one.");
        }
        // A citation is the fact the owner kept (its quote is read from the stored fact, never taken
        // from the client). The question ids on the wire are Carnet's row ids.
        const versions = new Map<string, Awaited<ReturnType<typeof getFactsVersionById>>>();
        const quoteOf = async (factVersionId: string): Promise<string> => {
          const [versionId, indexText] = factVersionId.split("#");
          if (!versionId) return "";
          if (!versions.has(versionId))
            versions.set(versionId, await getFactsVersionById(rc, versionId));
          return versions.get(versionId)?.facts[Number(indexText)]?.quote ?? "";
        };
        const answers = [];
        for (const a of body.answers) {
          const citations = [];
          for (const id of a.fact_version_ids) {
            citations.push({ fact_version_id: id, quote: await quoteOf(id) });
          }
          answers.push({
            questionId: a.question_id,
            text: a.text,
            documentIds: a.document_ids,
            citations,
            ownerAuthored: a.owner_authored,
          });
        }
        const result = await createOwnerDraft(rc, {
          rfiId: rfi.id,
          round: rfi.round,
          parentDraftId: latest?.id ?? null,
          draftKey: `owner:${key.data}`,
          userId: ctx.userId,
          answers,
        });
        if (!result) throw notFound();
        await appendAudit(rc, {
          actorType: "user",
          actorId: ctx.userId,
          action: "draft.owner_edit",
          subject: `rfi:${rfi.id}`,
          data: {
            draftId: result.draft.id,
            parentDraftId: latest?.id ?? null,
            state: result.draft.state,
          },
        });
        const response = { draft: { id: result.draft.id, state: result.draft.state } };
        await saveIdempotencyRecord(rc, {
          endpoint,
          key: key.data,
          requestHash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
          responseStatus: 201,
          response,
        });
        return Response.json(response, { status: 201, headers: { "cache-control": "no-store" } });
      });
    } catch (error) {
      if (error instanceof DuplicateIdempotencyKeyError) {
        const winner = await getIdempotencyRecord(repo, endpoint, key.data);
        if (winner) return Response.json(winner.response, { status: winner.responseStatus });
      }
      throw error;
    }
  },
});
