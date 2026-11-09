// RFI answer approvals (ADR 0008, M2-07). Routes (specs here, files under app/api/v1/rfis/[id]):
//
//   POST /api/v1/rfis/{id}/approvals                          owner, approver  → 201 { approval }
//   GET  /api/v1/rfis/{id}/approvals                          any session      → { items }
//   POST /api/v1/rfis/{id}/approvals/{approvalId}/reject      owner, approver  → { approval }
//
// Approve takes the draft exactly as the approver saw it (draft id, prompt version, each answer with its
// text, attachments by document id and the fact versions shown, plus the RFI `updated_at` they looked
// at) and binds it: the server re-reads the RFI, its active-round questions and every attachment's
// SHA-256 from its own rows, builds the `RfiAnswerSubject`, hashes it, stores the hash and the shown
// snapshot, moves the RFI DRAFT_READY → APPROVED and enqueues `rfi.respond`, all in one transaction. It
// calls nothing outside the database: the respond happens in the worker.
//
// Refused (no approval, nothing queued): RFI not DRAFT_READY, any answer NEEDS_OWNER, the RFI changed
// since the approver looked (`rfi_updated_at`), a question not answered or answered twice, an answer
// type or attachment Carnet cannot send, a draft that is not the latest, the kill switch off, or an RFI
// too close to its expiry. The role guard is server-side (viewer 403); another business's RFI or
// approval is 404.
import { createHash } from "node:crypto";
import {
  type Approval,
  appendAudit,
  createApproval,
  type DocumentRecord,
  DuplicateIdempotencyKeyError,
  effectiveApprovalStatus,
  endApproval,
  enqueueJob,
  getApproval,
  getDocument,
  getIdempotencyRecord,
  getRfi,
  getRfiForUpdate,
  getSystemFlags,
  type IdempotencyRecord,
  listApprovalsForSubject,
  listRfiQuestions,
  type RepoCtx,
  type Rfi,
  repoCtx,
  saveIdempotencyRecord,
  withTransaction,
} from "@carnet/db";
import {
  type ApprovalAnswer,
  ApprovalIdSchema,
  type ApprovalSubject,
  approvalCanonicalJson,
  approvalExpiry,
  approvalHash,
  approvalQuestionText,
  DEFAULT_APPROVAL_TTL_MINUTES,
  DocumentIdSchema,
  IdempotencyKeySchema,
  RfiIdSchema,
} from "@carnet/domain";
import { z } from "zod";
import type { AuthRule, RouteSpec } from "../lib/define-route";
import { conflict, HttpProblem, notFound } from "../lib/errors";
import { JOB_KIND } from "../worker/handlers/index";
import { moveRfi } from "./rfi-state";

type Schema = z.ZodType | undefined;
const routeSpec = <A extends AuthRule, B extends Schema, Q extends Schema, P extends Schema>(
  spec: RouteSpec<A, B, Q, P>,
) => spec;

export const APPROVE_ENDPOINT = (rfiId: string) => `POST /api/v1/rfis/${rfiId}/approvals`;
/** What Airwallex accepts as attachments from Carnet: PDF or JPEG only (M0-04). */
export const SENDABLE_MIMES = ["application/pdf", "image/jpeg"] as const;
const SENDABLE_TYPES = ["TEXT", "ATTACHMENT"] as const;
export const MAX_ANSWER_TEXT_CHARS = 10_000;

const AnswerBody = z.strictObject({
  question_id: z.string().min(1).max(128),
  /** NEEDS_OWNER is accepted only to be refused with a clear reason (the UI sends what it shows). */
  status: z.enum(["ANSWERED", "NEEDS_OWNER"]),
  type: z.enum(SENDABLE_TYPES),
  text: z.string().max(MAX_ANSWER_TEXT_CHARS),
  document_ids: z.array(DocumentIdSchema).max(10).default([]),
  fact_version_ids: z.array(z.string().min(1).max(128)).max(50).default([]),
});

export const ApproveBodySchema = z.strictObject({
  draft_id: z.string().min(1).max(128),
  prompt_version: z.string().min(1).max(128),
  /** The RFI's `airwallex_updated_at` the approver looked at (ISO); a newer one is a 409. */
  rfi_updated_at: z.iso.datetime({ offset: true }),
  answers: z.array(AnswerBody).min(1).max(50),
});
export type ApproveBody = z.infer<typeof ApproveBodySchema>;

const RfiParams = z.strictObject({ id: RfiIdSchema });
const ApprovalParams = z.strictObject({ id: RfiIdSchema, approvalId: ApprovalIdSchema });

export interface ApprovalDeps {
  readonly now?: () => Date;
  /** `APPROVAL_TTL_MINUTES` (default 30). */
  readonly ttlMinutes?: number;
  /**
   * True when `draftId` is the latest draft of this RFI round. The process specs
   * (`server/approval-routes.ts`) register the real lookup over the M2-05 drafts table; without one
   * (tests that build their own specs) any draft id the approver presents is bound as given.
   */
  readonly isLatestDraft?: (rc: RepoCtx, rfi: Rfi, draftId: string) => Promise<boolean>;
  /** The kill switch; defaults to `system_flags.execution_enabled` (a read error counts as off). */
  readonly executionEnabled?: (rc: RepoCtx) => Promise<boolean>;
}

export function approvalTtlMinutes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.APPROVAL_TTL_MINUTES);
  return Number.isInteger(n) && n >= 1 && n <= 24 * 60 ? n : DEFAULT_APPROVAL_TTL_MINUTES;
}

async function defaultExecutionEnabled(rc: RepoCtx): Promise<boolean> {
  try {
    return (await getSystemFlags(rc.db)).executionEnabled;
  } catch {
    return false;
  }
}

const refuse = (message: string, reason: string, extra: Record<string, unknown> = {}) =>
  new HttpProblem("PRECONDITION_FAILED", message, { details: { reason, ...extra } });

export interface ApprovalSnapshot {
  readonly version: 1;
  /** Exactly what the hash covers. */
  readonly subject: ApprovalSubject;
  /** Display fields for the attachments (not hashed; the document id and sha256 are). */
  readonly attachments: readonly {
    documentId: string;
    filename: string;
    mime: string;
    size: number;
    sha256: string;
  }[];
}

/** Reads the snapshot back from a stored approval; null when it is not the shape this code writes. */
export function snapshotOf(approval: Pick<Approval, "shownSnapshot">): ApprovalSnapshot | null {
  const s = approval.shownSnapshot;
  if (typeof s !== "object" || s === null) return null;
  const o = s as Partial<ApprovalSnapshot>;
  if (o.version !== 1 || typeof o.subject !== "object" || o.subject === null) return null;
  return o as ApprovalSnapshot;
}

export function approvalJson(a: Approval, now: Date) {
  return {
    id: a.id,
    kind: a.kind,
    rfi_id: a.subjectRef,
    status: effectiveApprovalStatus(a, now),
    end_reason: a.endReason,
    hash: a.hash,
    approver_id: a.approverId,
    expires_at: a.expiresAt.toISOString(),
    consumed_at: a.consumedAt?.toISOString() ?? null,
    created_at: a.createdAt.toISOString(),
    shown_snapshot: a.shownSnapshot,
  };
}

function idempotencyKeyOf(req: Request): string {
  const parsed = IdempotencyKeySchema.safeParse(req.headers.get("idempotency-key") ?? "");
  if (!parsed.success) {
    throw new HttpProblem(
      "VALIDATION_FAILED",
      "Send an Idempotency-Key header (8 to 128 visible characters). Nothing was approved.",
    );
  }
  return parsed.data;
}

const bodyHash = (body: ApproveBody): string =>
  createHash("sha256").update(approvalCanonicalJson(body)).digest("hex");

function replay(record: IdempotencyRecord, hash: string, requestId: string): Response {
  if (record.requestHash !== hash) {
    throw new HttpProblem(
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used for a different approval. Nothing was approved.",
    );
  }
  return Response.json(record.response, {
    status: record.responseStatus,
    headers: {
      "cache-control": "no-store",
      "idempotent-replayed": "true",
      "x-request-id": requestId,
    },
  });
}

interface Built {
  subject: ApprovalSubject;
  attachments: ApprovalSnapshot["attachments"];
}

async function buildSubject(
  rc: RepoCtx,
  rfi: Rfi,
  body: ApproveBody,
  approverId: ApprovalSubject["approverId"],
  nonce: string,
): Promise<Built> {
  // The questions of the active round, as stored when the RFI was ingested.
  const rows = (await listRfiQuestions(rc, rfi.id, rfi.round)).sort(
    (a, b) => a.position - b.position,
  );
  const questions = rows.map((q) => ({
    id: q.airwallexQuestionId,
    text: approvalQuestionText(q.title, q.description),
  }));
  const byId = new Map(rows.map((q) => [q.airwallexQuestionId, q]));
  const answered = new Map<string, ApproveBody["answers"][number]>();
  for (const a of body.answers) {
    if (!byId.has(a.question_id)) {
      throw refuse("An answer is for a question this RFI does not have.", "UNKNOWN_QUESTION", {
        question_id: a.question_id,
      });
    }
    if (answered.has(a.question_id)) {
      throw refuse("A question is answered twice.", "DUPLICATE_ANSWER", {
        question_id: a.question_id,
      });
    }
    answered.set(a.question_id, a);
  }
  const missing = questions.filter((q) => !answered.has(q.id));
  if (missing.length > 0) {
    throw refuse(
      "Every question must be answered: Airwallex rejects a partial response.",
      "UNANSWERED_QUESTIONS",
      { question_ids: missing.map((q) => q.id) },
    );
  }
  const blocking = body.answers.filter((a) => a.status === "NEEDS_OWNER").map((a) => a.question_id);
  if (blocking.length > 0) {
    throw refuse("An answer still needs the owner. Write it, then approve.", "NEEDS_OWNER_ANSWER", {
      question_ids: blocking,
    });
  }

  const docCache = new Map<string, DocumentRecord>();
  const attachments: ApprovalSnapshot["attachments"][number][] = [];
  const answers: ApprovalAnswer[] = [];
  for (const q of rows) {
    const a = answered.get(q.airwallexQuestionId);
    if (!a) continue;
    if (q.answerType !== a.type || !(SENDABLE_TYPES as readonly string[]).includes(q.answerType)) {
      throw refuse(
        "Carnet cannot send this kind of answer. Answer it in Airwallex.",
        "UNSUPPORTED_ANSWER_TYPE",
        { question_id: q.airwallexQuestionId, answer_type: q.answerType },
      );
    }
    if (a.type === "TEXT" && a.text.trim() === "") {
      throw refuse("A text answer is empty.", "EMPTY_ANSWER", { question_id: a.question_id });
    }
    if (a.type === "ATTACHMENT" && a.document_ids.length === 0) {
      throw refuse("An attachment answer has no document.", "EMPTY_ANSWER", {
        question_id: a.question_id,
      });
    }
    if (a.type === "TEXT" && a.document_ids.length > 0) {
      throw refuse("A text answer cannot carry documents.", "UNSUPPORTED_ANSWER_TYPE", {
        question_id: a.question_id,
      });
    }
    const docs: { documentId: string; sha256: string }[] = [];
    for (const documentId of a.document_ids) {
      let doc = docCache.get(documentId);
      if (!doc) {
        const found = await getDocument(rc, documentId);
        // Another business's document reads as absent: the same answer as one that does not exist.
        if (!found) throw notFound();
        doc = found;
        docCache.set(documentId, found);
      }
      if (!(SENDABLE_MIMES as readonly string[]).includes(doc.mime)) {
        throw refuse(
          "Only PDF or JPEG documents can be sent to Airwallex.",
          "UNSUPPORTED_ATTACHMENT",
          {
            document_id: documentId,
            mime: doc.mime,
          },
        );
      }
      docs.push({ documentId, sha256: doc.sha256 });
      if (!attachments.some((x) => x.documentId === documentId)) {
        attachments.push({
          documentId,
          filename: doc.filename,
          mime: doc.mime,
          size: doc.size,
          sha256: doc.sha256,
        });
      }
    }
    answers.push({
      questionId: q.airwallexQuestionId,
      type: a.type,
      text: a.text,
      attachments: docs,
      factVersionIds: a.fact_version_ids,
    });
  }

  const subject: ApprovalSubject = {
    kind: "rfi_answer",
    businessId: rfi.businessId,
    approverId,
    nonce,
    rfiId: rfi.id,
    rfiUpdatedAt: rfi.airwallexUpdatedAt.toISOString(),
    draftId: body.draft_id,
    promptVersion: body.prompt_version,
    questions,
    answers,
  };
  return { subject, attachments };
}

export interface ApproveInput {
  repo: RepoCtx;
  userId: ApprovalSubject["approverId"];
  rfiId: Rfi["id"];
  body: ApproveBody;
  key: string;
  requestId: string;
}

export async function approveRfiAnswer(
  input: ApproveInput,
  deps: ApprovalDeps = {},
): Promise<Response> {
  const { repo, userId, rfiId, body, key, requestId } = input;
  const now = deps.now ?? (() => new Date());
  const ttlMinutes = deps.ttlMinutes ?? approvalTtlMinutes();
  const endpoint = APPROVE_ENDPOINT(rfiId);
  const hash = bodyHash(body);
  const existing = await getIdempotencyRecord(repo, endpoint, key);
  if (existing) return replay(existing, hash, requestId);

  try {
    const created = await withTransaction(repo.db, async (tx) => {
      const rc = repoCtx(tx, repo.businessId);
      const rfi = await getRfiForUpdate(rc, rfiId);
      if (!rfi) throw notFound();
      if (rfi.state !== "DRAFT_READY") {
        throw conflict(
          `This RFI is ${rfi.state}, not ready to approve. Reload and check its draft.`,
        );
      }
      if (!(await (deps.executionEnabled ?? defaultExecutionEnabled)(rc))) {
        throw refuse(
          "Execution is switched off, so nothing can be approved or sent right now.",
          "KILL_SWITCH",
        );
      }
      if (new Date(body.rfi_updated_at).getTime() !== rfi.airwallexUpdatedAt.getTime()) {
        throw conflict("Airwallex changed this RFI since you looked at it. Reload, then approve.");
      }
      const latest = deps.isLatestDraft ?? (async () => true);
      if (!(await latest(rc, rfi, body.draft_id))) {
        throw conflict("A newer draft exists for this RFI. Reload, then approve that one.");
      }
      const expiresAt = approvalExpiry({ now: now(), ttlMinutes, rfiExpiresAt: rfi.expiresAt });
      if (!expiresAt) {
        throw refuse(
          "This RFI is too close to its expiry to approve. Answer it in Airwallex.",
          "TOO_CLOSE_TO_EXPIRY",
        );
      }
      const nonce = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
      const { subject, attachments } = await buildSubject(rc, rfi, body, userId, nonce);
      const approvalHashHex = approvalHash(subject);
      const snapshot: ApprovalSnapshot = { version: 1, subject, attachments };
      const approval = await createApproval(rc, {
        kind: "rfi_answer",
        subjectRef: rfi.id,
        hash: approvalHashHex,
        nonce,
        approverId: userId,
        expiresAt,
        shownSnapshot: snapshot,
      });
      await moveRfi(rc, rfi, "APPROVED", { actorType: "user", actorId: userId }, "approval", {
        approvalId: approval.id,
      });
      // Hash and ids only: the answer text lives in the snapshot, never in the audit log.
      await appendAudit(rc, {
        actorType: "user",
        actorId: userId,
        action: "approval.granted",
        subject: `rfi:${rfi.id}`,
        data: {
          approvalId: approval.id,
          hash: approvalHashHex,
          draftId: body.draft_id,
          promptVersion: body.prompt_version,
          expiresAt: expiresAt.toISOString(),
          attachments: attachments.map((a) => ({ documentId: a.documentId, sha256: a.sha256 })),
        },
      });
      await enqueueJob(tx, {
        kind: JOB_KIND.rfiRespond,
        payload: { businessId: repo.businessId, approvalId: approval.id, hash: approvalHashHex },
      });
      const response = { approval: approvalJson(approval, now()) };
      await saveIdempotencyRecord(rc, {
        endpoint,
        key,
        requestHash: hash,
        responseStatus: 201,
        response,
      });
      return response;
    });
    return Response.json(created, {
      status: 201,
      headers: { "cache-control": "no-store", "x-request-id": requestId },
    });
  } catch (error) {
    if (error instanceof DuplicateIdempotencyKeyError) {
      const winner = await getIdempotencyRecord(repo, endpoint, key);
      if (winner) return replay(winner, hash, requestId);
    }
    throw error;
  }
}

/** The owner or approver withdraws a live approval; the RFI returns to DRAFT_READY. */
export async function rejectApproval(
  repo: RepoCtx,
  userId: string,
  rfiId: Rfi["id"],
  approvalId: Approval["id"],
  now: Date,
): Promise<Response> {
  const result = await withTransaction(repo.db, async (tx) => {
    const rc = repoCtx(tx, repo.businessId);
    const rfi = await getRfiForUpdate(rc, rfiId);
    const approval = rfi ? await getApproval(rc, approvalId) : null;
    // An approval is reached through its own RFI only; any mismatch or foreign id is 404.
    if (!rfi || !approval || approval.subjectRef !== rfi.id) throw notFound();
    const ended = await endApproval(rc, approvalId, "REJECTED", "REJECTED_BY_USER");
    if (!ended) {
      throw conflict(`This approval is already ${effectiveApprovalStatus(approval, now)}.`);
    }
    await appendAudit(rc, {
      actorType: "user",
      actorId: userId,
      action: "approval.rejected",
      subject: `rfi:${rfi.id}`,
      data: { approvalId, hash: approval.hash },
    });
    if (rfi.state === "APPROVED") {
      await moveRfi(rc, rfi, "DRAFT_READY", { actorType: "user", actorId: userId }, "approval", {
        approvalId,
      });
    }
    return ended;
  });
  return Response.json(
    { approval: approvalJson(result, now) },
    { headers: { "cache-control": "no-store" } },
  );
}

export function approvalRouteSpecs(deps: ApprovalDeps = {}) {
  const now = deps.now ?? (() => new Date());

  const create = routeSpec({
    method: "POST",
    auth: { roles: ["owner", "approver"] as const },
    params: RfiParams,
    body: ApproveBodySchema,
    maxBodyBytes: 256 * 1024,
    rateLimit: { name: "approval", by: "user" },
    handler: async ({ req, ctx, repo, params, body, requestId }) =>
      approveRfiAnswer(
        { repo, userId: ctx.userId, rfiId: params.id, body, key: idempotencyKeyOf(req), requestId },
        deps,
      ),
  });

  const list = routeSpec({
    method: "GET",
    auth: "session",
    params: RfiParams,
    handler: async ({ repo, params }) => {
      const rfi = await getRfi(repo, params.id);
      if (!rfi) throw notFound();
      const items = await listApprovalsForSubject(repo, "rfi_answer", rfi.id);
      return Response.json(
        { items: items.map((a) => approvalJson(a, now())) },
        { headers: { "cache-control": "no-store" } },
      );
    },
  });

  const reject = routeSpec({
    method: "POST",
    auth: { roles: ["owner", "approver"] as const },
    params: ApprovalParams,
    rateLimit: { name: "approval", by: "user" },
    handler: async ({ ctx, repo, params }) =>
      rejectApproval(repo, ctx.userId, params.id, params.approvalId, now()),
  });

  return { create, list, reject };
}
