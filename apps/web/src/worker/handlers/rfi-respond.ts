// `rfi.respond` (ADR 0007, 0008, M2-07): the only code that answers an Airwallex RFI. It takes an approval
// and nothing a model produced: this module imports nothing from packages/agent (boundary test).
//
//   approved ──consume (atomic, + attempt INTENT, RFI → ANSWER_SUBMITTING)──▶ INTENT
//   INTENT ──checks pass, uploads done, committed──▶ SENT_TO_AIRWALLEX ──respond──▶ CONFIRMED (RFI ANSWERED)
//                                                           ├─ timeout / network / 5xx ──▶ UNKNOWN (reconcile)
//                                                           └─ 4xx ─────────────────────▶ REJECTED (RFI NEEDS_OWNER)
//   INTENT ──a check fails (RFI changed, tamper, kill switch)──▶ REJECTED + refusal code (nothing sent)
//
// Before anything is sent the executor re-reads the RFI from Airwallex and refuses unless it is still
// ACTION_REQUIRED with the same `updated_at` and question set as the approved subject; it re-loads each
// attachment's bytes and re-hashes them; and it re-derives the approval hash from that current state. Any
// difference refuses, writes the refusal code on the attempt and in the audit log, and sends nothing.
//
// Airwallex's respond carries no `request_id` on the wire (packages/airwallex rfis.ts), so the attempt's
// `request_id` is Carnet's identity for the intent and the retry guard is state: a second respond to an
// RFI that is no longer ACTION_REQUIRED is refused by Airwallex (`invalid_state_for_operation`). An
// unknown outcome is therefore resolved by fetching the RFI (`resolveRespondAttempt`), never by minting a
// new attempt for the same intent.
//
// The kill switch is enforced here, at consume (`execution_enabled=false` refuses and expires the
// approval), not by the loop's mutating-job deferral: an attempt already past INTENT must keep resolving.
import {
  AirwallexApiError,
  AirwallexInputError,
  AirwallexRateLimited,
  type Rfi as AirwallexRfi,
  type RfiAnswer,
  type UploadContentType,
} from "@carnet/airwallex";
import {
  type Approval,
  appendAudit,
  consumeApproval,
  type ExecutionAttempt,
  endApproval,
  enqueueJob,
  getApproval,
  getAttempt,
  getDocumentContent,
  getRfi,
  getRfiForUpdate,
  getSystemFlags,
  listAttemptsForRefs,
  type RepoCtx,
  type Rfi,
  repoCtx,
  sha256Hex,
  updateAttemptStatus,
  withTransaction,
} from "@carnet/db";
import {
  type ApprovalId,
  type ApprovalRefusalCode,
  type ApprovalSubject,
  type AttemptId,
  approvalHash,
  approvalQuestionText,
  type BusinessId,
  type DocumentId,
  type RfiState,
} from "@carnet/domain";
import { snapshotOf } from "../../server/approvals";
import { moveRfi } from "../../server/rfi-state";
import {
  type HandlerContext,
  JOB_KIND,
  type JobHandler,
  payloadString,
  requireWriter,
} from "./index";
import { parseAirwallexTime } from "./transfer";

export const ANSWER_SUBMITTED_EVENT = "answer.submitted";

const ACTOR = { actorType: "system", actorId: "worker" } as const;

/** What `execution_attempts.response` holds for a respond attempt. */
export interface RespondAttemptRecord {
  readonly approvalId: string;
  readonly hash: string;
  readonly sentAt?: string;
  readonly sends?: number;
  /** Files already uploaded for this attempt (a re-run reuses them). */
  readonly files?: readonly { documentId: string; sha256: string; fileId: string }[];
  readonly confirmedAt?: string;
  readonly airwallexStatus?: string;
  readonly refusal?: { code: ApprovalRefusalCode | string; message: string };
  readonly error?: { kind: string; code?: string; message: string };
  readonly resolvedBy?: string;
}

export function respondRecord(attempt: Pick<ExecutionAttempt, "response">): RespondAttemptRecord {
  const r = attempt.response;
  return typeof r === "object" && r !== null
    ? (r as RespondAttemptRecord)
    : { approvalId: "", hash: "" };
}

export type RespondOutcome =
  | { outcome: "confirmed"; attemptId: AttemptId }
  | { outcome: "unknown"; attemptId: AttemptId; error: string }
  | { outcome: "refused"; attemptId: AttemptId; code: string }
  | { outcome: "rejected"; attemptId: AttemptId; error: string }
  | { outcome: "consume_refused"; reason: string }
  | { outcome: "skipped"; reason: string };

function errorOf(error: unknown): { kind: string; code?: string; message: string } {
  if (error instanceof AirwallexApiError) {
    return { kind: error.name, code: error.code, message: error.message };
  }
  return {
    kind: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** A definite refusal by Airwallex: 4xx other than 429, so nothing was recorded. */
function isRejection(error: unknown): error is AirwallexApiError {
  return (
    error instanceof AirwallexApiError &&
    !(error instanceof AirwallexRateLimited) &&
    error.status >= 400 &&
    error.status < 500
  );
}

async function audit(
  rc: RepoCtx,
  rfiId: string,
  action: string,
  data: Record<string, unknown>,
): Promise<void> {
  await appendAudit(rc, { ...ACTOR, action, subject: `rfi:${rfiId}`, data });
}

/** Moves the RFI out of ANSWER_SUBMITTING (or APPROVED) when it is still there; otherwise leaves it. */
async function settleRfi(
  rc: RepoCtx,
  rfiId: Rfi["id"],
  from: readonly RfiState[],
  to: RfiState,
  source: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const rfi = await getRfiForUpdate(rc, rfiId);
  if (!rfi || !from.includes(rfi.state)) return false;
  await moveRfi(rc, rfi, to, ACTOR, source, extra);
  return true;
}

/** The event has no consumer until M2-06; it is delivered and logged so the job never goes DEAD. */
export const handleAnswerSubmitted: JobHandler = async (payload, ctx) => {
  ctx.logger.info(
    { rfiId: payloadString(payload, "rfiId"), event: ANSWER_SUBMITTED_EVENT },
    "answer submitted",
  );
};

// --- consume, then execute -------------------------------------------------------------------------

/** Payload: `{ businessId, approvalId, hash }`, written by the approve endpoint. */
export const handleRfiRespond: JobHandler = async (payload, ctx) => {
  const businessId = payloadString(payload, "businessId") as BusinessId;
  const approvalId = payloadString(payload, "approvalId") as ApprovalId;
  const hash = payloadString(payload, "hash");
  await runRfiRespond(ctx, { businessId, approvalId, hash });
};

export async function runRfiRespond(
  ctx: HandlerContext,
  input: { businessId: BusinessId; approvalId: ApprovalId; hash: string },
  now: () => Date = () => new Date(),
): Promise<RespondOutcome> {
  requireWriter(ctx); // a missing client fails the job before anything is consumed
  const rc = repoCtx(ctx.db, input.businessId);
  const approval = await getApproval(rc, input.approvalId);
  if (!approval) return { outcome: "skipped", reason: "approval not found" };
  const rfiRow = await getRfi(rc, approval.subjectRef as Rfi["id"]);
  if (!rfiRow) return { outcome: "skipped", reason: "rfi not found" };

  // An attempt already exists for this approval: a re-run (retry, or an expired lease) continues it.
  const existing = (await listAttemptsForRefs(rc, "respond", [approval.subjectRef])).find(
    (a) => respondRecord(a).approvalId === approval.id,
  );
  if (existing) return continueAttempt(ctx, rc, existing, approval, now);

  if (rfiRow.state === "ANSWERED") {
    // Already answered (by Carnet earlier, or in Airwallex): a no-op success, nothing is consumed.
    return { outcome: "skipped", reason: "rfi already answered" };
  }
  if (approval.status === "APPROVED" && rfiRow.state !== "APPROVED") {
    await withTransaction(ctx.db, async (tx) => {
      const t = repoCtx(tx, input.businessId);
      await endApproval(t, approval.id, "EXPIRED", "RFI_CHANGED");
      await audit(t, rfiRow.id, "approval.expired", {
        approvalId: approval.id,
        reason: "RFI_CHANGED",
        rfiState: rfiRow.state,
      });
    });
    return { outcome: "consume_refused", reason: "RFI_CHANGED" };
  }

  const result = await consumeApproval(rc, {
    approvalId: approval.id,
    expectedHash: input.hash,
    inTransaction: async (tx, consumed, attempt) => {
      const rfi = await getRfiForUpdate(tx, rfiRow.id);
      if (rfi?.state !== "APPROVED")
        throw new Error("rfi is no longer APPROVED; consume rolled back");
      await moveRfi(tx, rfi, "ANSWER_SUBMITTING", ACTOR, "executor", {
        approvalId: consumed.id,
        attemptId: attempt.id,
      });
      await audit(tx, rfi.id, "approval.consumed", {
        approvalId: consumed.id,
        hash: consumed.hash,
        attemptId: attempt.id,
        requestId: attempt.requestId,
      });
      await audit(tx, rfi.id, "attempt.created", {
        attemptId: attempt.id,
        kind: "respond",
        status: "INTENT",
        requestId: attempt.requestId,
      });
    },
  });
  if (result.outcome === "refused") {
    await withTransaction(ctx.db, async (tx) => {
      const t = repoCtx(tx, input.businessId);
      await audit(t, rfiRow.id, "approval.consume_refused", {
        approvalId: approval.id,
        reason: result.reason,
      });
      if (result.reason === "EXPIRED") {
        await endApproval(t, approval.id, "EXPIRED", "TTL");
      }
      if (result.reason === "EXPIRED" || result.reason === "KILL_SWITCH") {
        await audit(t, rfiRow.id, "approval.expired", {
          approvalId: approval.id,
          reason: result.reason === "EXPIRED" ? "TTL" : "KILL_SWITCH",
        });
        // The approval ended without being consumed: the draft goes back to the owner.
        await settleRfi(t, rfiRow.id, ["APPROVED"], "DRAFT_READY", "approval", {
          approvalId: approval.id,
        });
      }
    });
    ctx.logger.warn(
      { approvalId: approval.id, reason: result.reason },
      "approval not consumed; nothing sent",
    );
    return { outcome: "consume_refused", reason: result.reason };
  }
  ctx.logger.info(
    { approvalId: approval.id, attemptId: result.attempt.id, requestId: result.attempt.requestId },
    "approval consumed; respond attempt created",
  );
  return continueAttempt(ctx, rc, result.attempt, result.approval, now);
}

async function continueAttempt(
  ctx: HandlerContext,
  rc: RepoCtx,
  attempt: ExecutionAttempt,
  approval: Approval,
  now: () => Date,
): Promise<RespondOutcome> {
  if (attempt.status === "INTENT" || attempt.status === "SENT_TO_AIRWALLEX") {
    return executeRespondAttempt(ctx, rc.businessId, attempt.id, now);
  }
  // CONFIRMED and REJECTED are done; UNKNOWN belongs to the reconciler (lookup, never a new attempt).
  ctx.logger.info(
    { attemptId: attempt.id, status: attempt.status, approvalId: approval.id },
    "respond attempt already past sending; nothing to do",
  );
  return { outcome: "skipped", reason: `attempt ${attempt.status}` };
}

// --- the executor ----------------------------------------------------------------------------------

const EXTENSION: Record<UploadContentType, { re: RegExp; ext: string }> = {
  "application/pdf": { re: /\.pdf$/i, ext: ".pdf" },
  "image/jpeg": { re: /\.jpe?g$/i, ext: ".jpg" },
};

/** A filename the files host accepts: at most 50 characters, with the extension of its type. */
export function uploadFilename(filename: string, contentType: UploadContentType): string {
  const { re, ext } = EXTENSION[contentType];
  if (re.test(filename) && filename.length <= 50) return filename;
  const stem = filename.replace(/\.[A-Za-z0-9]{1,5}$/, "").replaceAll(/[/\\\0]/g, "_");
  return `${stem.slice(0, 50 - ext.length) || "document"}${ext}`;
}

class Refusal extends Error {
  readonly code: ApprovalRefusalCode;
  /** Where the RFI goes when the refusal ends the attempt. */
  readonly rfiTo: RfiState;
  constructor(code: ApprovalRefusalCode, message: string, rfiTo: RfiState = "NEEDS_OWNER") {
    super(message);
    this.code = code;
    this.rfiTo = rfiTo;
  }
}

function questionsOf(live: AirwallexRfi): { id: string; text: string }[] {
  return (live.activeRequest?.questions ?? []).map((q) => ({
    id: q.id,
    text: approvalQuestionText(q.title, q.description),
  }));
}

/** Checks 1 to 3 of the executor (a, b, c): throws a Refusal, never sends. */
async function verifyAgainstCurrentState(
  rc: RepoCtx,
  approval: Approval,
  subject: ApprovalSubject,
  live: AirwallexRfi,
): Promise<{ bytes: Map<string, { bytes: Uint8Array; mime: string; filename: string }> }> {
  if (approvalHash(subject) !== approval.hash) {
    throw new Refusal("HASH_MISMATCH", "The stored approval no longer matches its hash.");
  }
  if (live.status === "CLOSED") {
    throw new Refusal("RFI_NOT_ACTION_REQUIRED", "Airwallex has closed this RFI.", "EXPIRED");
  }
  if (live.status !== "ACTION_REQUIRED") {
    throw new Refusal(
      "RFI_NOT_ACTION_REQUIRED",
      `Airwallex reports this RFI as ${live.status}.`,
      "ANSWERED",
    );
  }
  const liveUpdatedAt = parseAirwallexTime(live.updatedAt).toISOString();
  if (liveUpdatedAt !== subject.rfiUpdatedAt) {
    throw new Refusal("RFI_UPDATED", "Airwallex changed this RFI after it was approved.");
  }
  const liveQuestions = questionsOf(live);
  const same =
    liveQuestions.length === subject.questions.length &&
    liveQuestions.every((q, i) => {
      const s = subject.questions[i];
      return s !== undefined && s.id === q.id && s.text === q.text;
    });
  if (!same) {
    throw new Refusal("QUESTIONS_CHANGED", "The questions changed after this answer was approved.");
  }

  // (c) the attachment bytes, re-hashed.
  const bytes = new Map<string, { bytes: Uint8Array; mime: string; filename: string }>();
  const current: ApprovalSubject = {
    ...subject,
    rfiUpdatedAt: liveUpdatedAt,
    questions: liveQuestions,
    answers: [],
  };
  const answers = [];
  for (const a of subject.answers) {
    const attachments = [];
    for (const att of a.attachments) {
      const content = await getDocumentContent(rc, att.documentId as DocumentId);
      if (!content) throw new Refusal("ATTACHMENT_MISSING", "An approved document is gone.");
      const sha = sha256Hex(content.bytes);
      if (sha !== att.sha256) {
        throw new Refusal("ATTACHMENT_CHANGED", "An approved document's bytes changed.");
      }
      bytes.set(att.documentId, {
        bytes: content.bytes,
        mime: content.document.mime,
        filename: content.document.filename,
      });
      attachments.push({ documentId: att.documentId, sha256: sha });
    }
    answers.push({ ...a, attachments });
  }
  // (b) the hash re-derived from current state equals the approved one.
  if (approvalHash({ ...current, answers }) !== approval.hash) {
    throw new Refusal("HASH_MISMATCH", "The current state does not hash to the approved hash.");
  }
  return { bytes };
}

export async function executeRespondAttempt(
  ctx: HandlerContext,
  businessId: BusinessId,
  attemptId: AttemptId,
  now: () => Date = () => new Date(),
  mode: "first" | "retry" = "first",
): Promise<RespondOutcome> {
  const writer = requireWriter(ctx);
  const rc = repoCtx(ctx.db, businessId);
  const attempt = await getAttempt(rc, attemptId);
  if (attempt?.kind !== "respond") throw new Error("respond attempt not found");
  const retryable =
    attempt.status === "INTENT" ||
    attempt.status === "SENT_TO_AIRWALLEX" ||
    (mode === "retry" && attempt.status === "UNKNOWN");
  if (!retryable) return { outcome: "skipped", reason: `attempt ${attempt.status}` };
  const prior = respondRecord(attempt);
  const approval = await getApproval(rc, prior.approvalId as ApprovalId);
  const rfi = await getRfi(rc, attempt.refId as Rfi["id"]);
  if (!approval || !rfi) throw new Error("approval or rfi for the respond attempt not found");
  const snapshot = snapshotOf(approval);

  const refuse = async (r: Refusal): Promise<RespondOutcome> => {
    await withTransaction(ctx.db, async (tx) => {
      const t = repoCtx(tx, businessId);
      await updateAttemptStatus(t, attempt.id, "REJECTED", {
        ...prior,
        refusal: { code: r.code, message: r.message },
      });
      await audit(t, rfi.id, "respond.refused", {
        attemptId: attempt.id,
        approvalId: approval.id,
        code: r.code,
      });
      await settleRfi(t, rfi.id, ["ANSWER_SUBMITTING"], r.rfiTo, "executor", {
        attemptId: attempt.id,
        refusal: r.code,
      });
    });
    ctx.logger.warn(
      { attemptId: attempt.id, requestId: attempt.requestId, code: r.code },
      "respond refused before sending; nothing was sent",
    );
    return { outcome: "refused", attemptId: attempt.id, code: r.code };
  };

  if (!snapshot) {
    return refuse(new Refusal("HASH_MISMATCH", "The approval's shown snapshot is unreadable."));
  }
  const subject = snapshot.subject;

  // (a) the RFI as Airwallex has it now. A failed read leaves the attempt as it is (the job retries).
  const live = await ctx.airwallex.getRfi(rfi.airwallexRfiId);

  if (live.status === "ANSWERED" && attempt.status === "SENT_TO_AIRWALLEX") {
    // A re-run after a crash between the send and its record: Airwallex has the answer.
    return confirm(ctx, rc, attempt, rfi, approval, prior, now, "rerun_lookup");
  }
  let verified: Awaited<ReturnType<typeof verifyAgainstCurrentState>>;
  try {
    verified = await verifyAgainstCurrentState(rc, approval, subject, live);
  } catch (error) {
    if (error instanceof Refusal) return refuse(error);
    throw error;
  }

  // (d) uploads, once per document: a re-run reuses the file ids already recorded.
  const files = [...(prior.files ?? [])];
  for (const [documentId, doc] of verified.bytes) {
    const sha = subject.answers
      .flatMap((a) => a.attachments)
      .find((x) => x.documentId === documentId)?.sha256;
    if (!sha || files.some((f) => f.documentId === documentId && f.sha256 === sha)) continue;
    if (doc.mime !== "application/pdf" && doc.mime !== "image/jpeg") {
      return refuse(new Refusal("ATTACHMENT_UNSUPPORTED", "Only PDF or JPEG can be sent."));
    }
    try {
      const uploaded = await writer.uploadFile({
        filename: uploadFilename(doc.filename, doc.mime),
        contentType: doc.mime,
        bytes: doc.bytes,
      });
      files.push({ documentId, sha256: sha, fileId: uploaded.fileId });
      await updateAttemptStatus(rc, attempt.id, attempt.status, { ...prior, files });
      await audit(rc, rfi.id, "attachment.uploaded", {
        attemptId: attempt.id,
        documentId,
        sha256: sha,
        fileId: uploaded.fileId,
      });
    } catch (error) {
      if (error instanceof AirwallexInputError || isRejection(error)) {
        return refuse(
          new Refusal(
            "ATTACHMENT_UNSUPPORTED",
            `The files host refused an attachment: ${errorOf(error).message}`,
          ),
        );
      }
      throw error; // network, 5xx, 429: nothing was sent to the RFI; the job retries
    }
  }

  // (e) the body: every question of the live request, TEXT with text, ATTACHMENT with file ids.
  const answers = (live.activeRequest?.questions ?? []).map((q) => {
    const a = subject.answers.find((x) => x.questionId === q.id);
    if (!a) throw new Error("approved subject lacks an answer the live RFI asks for");
    const answer: RfiAnswer =
      a.type === "TEXT"
        ? { type: "TEXT", text: a.text }
        : {
            type: "ATTACHMENT",
            attachments: a.attachments.map((att) => ({
              file_id:
                files.find((f) => f.documentId === att.documentId && f.sha256 === att.sha256)
                  ?.fileId ?? "",
            })),
            ...(a.text.trim() === "" ? {} : { comment: a.text }),
          };
    return { questionId: q.id, answer };
  });

  // (f) the intent is committed before the call; a crash from here on leaves SENT_TO_AIRWALLEX.
  const sending: RespondAttemptRecord = {
    ...prior,
    files,
    sentAt: prior.sentAt ?? now().toISOString(),
    sends: (prior.sends ?? 0) + 1,
  };
  await updateAttemptStatus(rc, attempt.id, "SENT_TO_AIRWALLEX", sending);
  await audit(rc, rfi.id, "attempt.sent", {
    attemptId: attempt.id,
    requestId: attempt.requestId,
    sends: sending.sends,
  });
  ctx.logger.info(
    { attemptId: attempt.id, requestId: attempt.requestId, rfiId: rfi.id, sends: sending.sends },
    "sending RFI answer to Airwallex",
  );

  try {
    await writer.respondRfi({
      rfiId: rfi.airwallexRfiId,
      answers,
      activeQuestionIds: (live.activeRequest?.questions ?? []).map((q) => q.id),
    });
  } catch (error) {
    if (error instanceof AirwallexRateLimited) throw error; // nothing recorded; the job retries
    const detail = errorOf(error);
    if (isRejection(error)) return rejected(ctx, rc, attempt, rfi, approval, sending, error, now);
    // Timeout, network error, 5xx or an unreadable 2xx: the outcome is UNKNOWN. The attempt keeps its
    // request_id; the reconciler looks the RFI up (it never sends a second, different attempt).
    await updateAttemptStatus(rc, attempt.id, "UNKNOWN", { ...sending, error: detail });
    await audit(rc, rfi.id, "attempt.unknown", {
      attemptId: attempt.id,
      requestId: attempt.requestId,
      error: detail,
    });
    ctx.logger.error(
      {
        attemptId: attempt.id,
        requestId: attempt.requestId,
        error: detail,
        alert: "attempt_unknown",
      },
      "respond outcome unknown; the reconciler will look the RFI up",
    );
    return { outcome: "unknown", attemptId: attempt.id, error: detail.message };
  }
  return confirm(ctx, rc, attempt, rfi, approval, sending, now, "respond");
}

async function confirm(
  ctx: HandlerContext,
  rc: RepoCtx,
  attempt: ExecutionAttempt,
  rfi: Rfi,
  approval: Approval,
  record: RespondAttemptRecord,
  now: () => Date,
  resolvedBy: string,
): Promise<RespondOutcome> {
  await withTransaction(ctx.db, async (tx) => {
    const t = repoCtx(tx, rc.businessId);
    await updateAttemptStatus(t, attempt.id, "CONFIRMED", {
      ...record,
      confirmedAt: now().toISOString(),
      airwallexStatus: "ANSWERED",
      resolvedBy,
    });
    await audit(t, rfi.id, "respond.confirmed", {
      attemptId: attempt.id,
      requestId: attempt.requestId,
      approvalId: approval.id,
      resolvedBy,
    });
    const moved = await settleRfi(t, rfi.id, ["ANSWER_SUBMITTING"], "ANSWERED", "executor", {
      attemptId: attempt.id,
    });
    // The event M2-06 consumes; the audit row is its record, the job its delivery (outbox).
    await audit(t, rfi.id, ANSWER_SUBMITTED_EVENT, {
      approvalId: approval.id,
      attemptId: attempt.id,
      hash: approval.hash,
    });
    await enqueueJob(tx, {
      kind: JOB_KIND.answerSubmitted,
      payload: {
        businessId: rc.businessId,
        rfiId: rfi.id,
        approvalId: approval.id,
        attemptId: attempt.id,
        stateMoved: moved,
      },
    });
  });
  ctx.logger.info(
    { attemptId: attempt.id, requestId: attempt.requestId, rfiId: rfi.id, resolvedBy },
    "RFI answered in Airwallex",
  );
  return { outcome: "confirmed", attemptId: attempt.id };
}

async function rejected(
  ctx: HandlerContext,
  rc: RepoCtx,
  attempt: ExecutionAttempt,
  rfi: Rfi,
  approval: Approval,
  record: RespondAttemptRecord,
  error: AirwallexApiError,
  now: () => Date,
): Promise<RespondOutcome> {
  const detail = errorOf(error);
  // "invalid state": the RFI is no longer waiting for an answer. Ask Airwallex which way it went.
  if (error.code === "invalid_state_for_operation") {
    const live = await ctx.airwallex.getRfi(rfi.airwallexRfiId);
    if (live.status === "ANSWERED") {
      return confirm(ctx, rc, attempt, rfi, approval, record, now, "invalid_state_lookup");
    }
    if (live.status === "CLOSED") {
      await withTransaction(ctx.db, async (tx) => {
        const t = repoCtx(tx, rc.businessId);
        await updateAttemptStatus(t, attempt.id, "REJECTED", {
          ...record,
          error: detail,
          refusal: { code: "RFI_NOT_ACTION_REQUIRED", message: "Airwallex has closed this RFI." },
        });
        await audit(t, rfi.id, "respond.rejected", {
          attemptId: attempt.id,
          error: detail,
          airwallexStatus: live.status,
        });
        await settleRfi(t, rfi.id, ["ANSWER_SUBMITTING"], "EXPIRED", "executor", {
          attemptId: attempt.id,
        });
      });
      return { outcome: "rejected", attemptId: attempt.id, error: detail.message };
    }
  }
  await withTransaction(ctx.db, async (tx) => {
    const t = repoCtx(tx, rc.businessId);
    await updateAttemptStatus(t, attempt.id, "REJECTED", { ...record, error: detail });
    await audit(t, rfi.id, "respond.rejected", { attemptId: attempt.id, error: detail });
    await settleRfi(t, rfi.id, ["ANSWER_SUBMITTING"], "NEEDS_OWNER", "executor", {
      attemptId: attempt.id,
      reason: detail.message,
    });
  });
  ctx.logger.warn(
    { attemptId: attempt.id, error: detail },
    "Airwallex rejected the RFI answer; the owner must re-draft and approve again",
  );
  return { outcome: "rejected", attemptId: attempt.id, error: detail.message };
}

// --- reconcile: an UNKNOWN respond attempt ---------------------------------------------------------

export type RespondResolution =
  | { resolution: "confirmed" }
  | { resolution: "retried"; outcome: RespondOutcome }
  | { resolution: "needs_owner"; reason: string }
  | { resolution: "expired" }
  | { resolution: "unresolved"; reason: string };

/**
 * Resolves one UNKNOWN respond attempt by fetching the RFI (ADR 0007). ANSWERED: CONFIRMED, no second
 * respond. CLOSED: the RFI is EXPIRED. ACTION_REQUIRED with the approved questions and `updated_at`:
 * the same intent is sent again on the same attempt (same request_id) while the approval's validity
 * lasts and execution is enabled; otherwise the attempt is REJECTED and the RFI is NEEDS_OWNER (a new
 * approval is required). Lookups run under the kill switch; a re-send does not.
 */
export async function resolveRespondAttempt(
  ctx: HandlerContext,
  ref: { businessId: BusinessId; attemptId: AttemptId },
  now: () => Date = () => new Date(),
): Promise<RespondResolution> {
  const rc = repoCtx(ctx.db, ref.businessId);
  const attempt = await getAttempt(rc, ref.attemptId);
  if (attempt?.kind !== "respond" || attempt.status !== "UNKNOWN") {
    return { resolution: "unresolved", reason: "not an UNKNOWN respond attempt" };
  }
  const record = respondRecord(attempt);
  const approval = await getApproval(rc, record.approvalId as ApprovalId);
  const rfi = await getRfi(rc, attempt.refId as Rfi["id"]);
  if (!approval || !rfi) return { resolution: "unresolved", reason: "approval or rfi missing" };
  const live = await ctx.airwallex.getRfi(rfi.airwallexRfiId);

  if (live.status === "ANSWERED") {
    await confirm(ctx, rc, attempt, rfi, approval, record, now, "reconcile_lookup");
    return { resolution: "confirmed" };
  }
  if (live.status === "CLOSED") {
    await withTransaction(ctx.db, async (tx) => {
      const t = repoCtx(tx, ref.businessId);
      await updateAttemptStatus(t, attempt.id, "REJECTED", {
        ...record,
        refusal: { code: "RFI_NOT_ACTION_REQUIRED", message: "Airwallex has closed this RFI." },
        resolvedBy: "reconcile_lookup",
      });
      await audit(t, rfi.id, "respond.resolved", {
        attemptId: attempt.id,
        airwallexStatus: live.status,
        outcome: "EXPIRED",
      });
      await settleRfi(t, rfi.id, ["ANSWER_SUBMITTING"], "EXPIRED", "reconcile", {
        attemptId: attempt.id,
      });
    });
    return { resolution: "expired" };
  }

  // ACTION_REQUIRED: still unanswered.
  const snapshot = snapshotOf(approval);
  const sameIntent =
    snapshot !== null &&
    parseAirwallexTime(live.updatedAt).toISOString() === snapshot.subject.rfiUpdatedAt &&
    JSON.stringify(questionsOf(live)) === JSON.stringify(snapshot.subject.questions);
  const valid = approval.expiresAt.getTime() > now().getTime();
  let enabled = false;
  try {
    enabled = (await getSystemFlags(ctx.db)).executionEnabled;
  } catch {
    enabled = false;
  }
  if (sameIntent && valid) {
    if (!enabled) {
      return { resolution: "unresolved", reason: "execution disabled; not re-sending" };
    }
    const outcome = await executeRespondAttempt(ctx, ref.businessId, attempt.id, now, "retry");
    return { resolution: "retried", outcome };
  }
  const reason = sameIntent ? "APPROVAL_EXPIRED" : "RFI_CHANGED";
  await withTransaction(ctx.db, async (tx) => {
    const t = repoCtx(tx, ref.businessId);
    await updateAttemptStatus(t, attempt.id, "REJECTED", {
      ...record,
      refusal: { code: reason, message: "A new approval is required." },
      resolvedBy: "reconcile_lookup",
    });
    await audit(t, rfi.id, "respond.resolved", {
      attemptId: attempt.id,
      airwallexStatus: live.status,
      outcome: "NEEDS_OWNER",
      reason,
    });
    await settleRfi(t, rfi.id, ["ANSWER_SUBMITTING"], "NEEDS_OWNER", "reconcile", {
      attemptId: attempt.id,
      reason,
    });
  });
  return { resolution: "needs_owner", reason };
}
