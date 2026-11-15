// Documents API (M2-01, ADR 0003, architecture §8). The route specs are built here so tests declare
// the same handlers on a test kit; src/app/api/v1/documents/** declare them with the process
// `defineRoute`.
//
//   POST /api/v1/documents            multipart: `file` (exactly one), optional `kind`
//                                     201 new · 200 { deduplicated: true } · 4xx with details.reason
//   GET  /api/v1/documents/{id}       the bytes, as an attachment (nosniff, private no-store)
//   GET  /api/v1/documents/{id}/meta  metadata only
//
// Order on upload: session file cap (429 before the body is read) → body read under a hard cap (413)
// → exactly one `file` → type by magic bytes → PDF pages and encryption → session byte cap → store
// (dedupe per business) and audit in one transaction. Every outcome after authentication writes an
// audit entry with the actor, reason, size and sha256, never the bytes.
import {
  appendAudit,
  getDocument,
  getDocumentContent,
  hitRateLimit,
  type RepoCtx,
  refundRateLimit,
  repoCtx,
  sha256Hex,
  storeDocument,
  withTransaction,
} from "@carnet/db";
import {
  DOCUMENT_AUDIT_ACTIONS,
  DOCUMENT_REASON_ERROR,
  DOCUMENT_REASON_MESSAGE,
  DocumentIdSchema,
  type DocumentKind,
  DocumentKindSchema,
  type DocumentMeta,
  type DocumentRejectReason,
  type DocumentUploadResponse,
  extractionTypeOf,
  inspectDocumentBytes,
  sanitizeFilename,
} from "@carnet/domain";
import { z } from "zod";
import type { AuthCtx } from "../../lib/authz";
import type {
  MultipartFile,
  MultipartForm,
  MultipartSpec,
  RouteSpec,
} from "../../lib/define-route";
import {
  type ErrorLog,
  type FieldIssue,
  HttpProblem,
  notFound,
  validationFailed,
} from "../../lib/errors";
import { rateLimitKey } from "../../lib/ratelimit";
import { assertSessionModelBudget } from "../session-caps";
import { enqueueDocumentExtraction } from "./jobs";
import { type UploadLimits, uploadLimits } from "./limits";
import { checkPdf } from "./pdf";

export interface DocumentRouteDeps {
  readonly limits?: () => UploadLimits;
  readonly now?: () => Date;
  readonly logger: () => ErrorLog;
}

const idParams = z.strictObject({ id: DocumentIdSchema });
type IdParams = typeof idParams;

export interface DocumentRouteSpecs {
  readonly upload: RouteSpec<"session", undefined, undefined, undefined, MultipartSpec>;
  readonly download: RouteSpec<"session", undefined, undefined, IdParams>;
  readonly meta: RouteSpec<"session", undefined, undefined, IdParams>;
}

const FILE_FIELD = "file";
const KIND_FIELD = "kind";

/** A refused upload in the ADR 0004 format, with its stable reason code in `details.reason`. */
export function documentRejected(
  reason: DocumentRejectReason,
  retryAfterSeconds?: number,
): HttpProblem {
  const code = DOCUMENT_REASON_ERROR[reason];
  const message = DOCUMENT_REASON_MESSAGE[reason];
  const details: Record<string, unknown> = { reason };
  const headers: Record<string, string> = {};
  if (code === "VALIDATION_FAILED") {
    details.issues = [
      { location: "body", path: FILE_FIELD, code: reason.toLowerCase(), message },
    ] satisfies FieldIssue[];
  }
  if (retryAfterSeconds !== undefined) {
    details.retry_after_seconds = retryAfterSeconds;
    headers["retry-after"] = String(retryAfterSeconds);
  }
  return new HttpProblem(code, message, { details, headers });
}

function reasonOf(error: unknown): string {
  if (!(error instanceof HttpProblem)) return "INTERNAL";
  const reason = error.details?.reason;
  return typeof reason === "string" ? reason : error.code;
}

/** Exactly one `file` part and at most one valid `kind`; nothing else. */
function parseForm(form: MultipartForm): { file: MultipartFile; kind: DocumentKind } {
  const issues: FieldIssue[] = [];
  const files = form.files.filter((f) => f.field === FILE_FIELD);
  if (files.length !== 1) {
    issues.push({
      location: "body",
      path: FILE_FIELD,
      code: files.length === 0 ? "required" : "too_many",
      message: "Send exactly one file in the `file` field.",
    });
  }
  const unknown = new Set(
    [...form.files, ...form.fields]
      .map((p) => p.field)
      .filter((f) => f !== FILE_FIELD && f !== KIND_FIELD),
  );
  for (const field of form.fields) {
    if (field.field === FILE_FIELD) unknown.add(FILE_FIELD);
  }
  for (const key of unknown) {
    issues.push({
      location: "body",
      path: key.slice(0, 64),
      code: key === FILE_FIELD ? "invalid_type" : "unrecognized_keys",
      message: key === FILE_FIELD ? "`file` must be a file part." : "Unknown field.",
    });
  }
  const kinds = form.fields.filter((f) => f.field === KIND_FIELD);
  let kind: DocumentKind = "other";
  if (form.files.some((f) => f.field === KIND_FIELD) || kinds.length > 1) {
    issues.push({
      location: "body",
      path: KIND_FIELD,
      code: "invalid_type",
      message: "Send one kind.",
    });
  } else if (kinds[0]) {
    const parsed = DocumentKindSchema.safeParse(kinds[0].value);
    if (parsed.success) kind = parsed.data;
    else {
      issues.push({
        location: "body",
        path: KIND_FIELD,
        code: "invalid_value",
        message: "Kind must be invoice, contract, purchase_order, statement or other.",
      });
    }
  }
  const file = files[0];
  if (issues.length > 0 || !file) throw validationFailed(issues);
  return { file, kind };
}

function toMeta(d: {
  id: string;
  kind: DocumentKind;
  filename: string;
  mime: DocumentMeta["mime"];
  size: number;
  sha256: string;
  createdAt: Date;
}): DocumentMeta {
  return {
    id: d.id as DocumentMeta["id"],
    kind: d.kind,
    filename: d.filename,
    mime: d.mime,
    size: d.size,
    sha256: d.sha256,
    created_at: d.createdAt.toISOString(),
  };
}

const NO_STORE = { "cache-control": "private, no-store" } as const;

export function documentRouteSpecs(deps: DocumentRouteDeps): DocumentRouteSpecs {
  const limits = deps.limits ?? (() => uploadLimits());
  const now = deps.now ?? (() => new Date());

  async function auditRejection(
    repo: RepoCtx,
    ctx: AuthCtx,
    error: unknown,
    facts: { size?: number; sha256?: string },
  ): Promise<void> {
    try {
      await appendAudit(repo, {
        actorType: "user",
        actorId: ctx.userId,
        action: DOCUMENT_AUDIT_ACTIONS.rejected,
        subject: "document",
        data: { reason: reasonOf(error), ...facts },
      });
    } catch (auditError) {
      // The refusal stands; a failed audit write is logged, never turned into a 500 for the client.
      deps.logger().error(
        {
          event: "document.audit_failed",
          errClass: auditError instanceof Error ? auditError.name : typeof auditError,
        },
        "audit write failed",
      );
    }
  }

  const upload: DocumentRouteSpecs["upload"] = {
    method: "POST",
    auth: "session",
    multipart: { maxBytes: () => limits().maxBytes },
    handler: async ({ ctx, repo, multipart }) => {
      const facts: { size?: number; sha256?: string } = {};
      const at = now();
      const rules = limits();
      const subject = ctx.sessionId ?? ctx.userId;
      const filesKey = rateLimitKey("upload_files", "session", subject);
      const bytesKey = rateLimitKey("upload_bytes", "session", subject);
      const filesRule = { limit: rules.sessionMaxFiles, windowMs: rules.windowMs };
      const bytesRule = { limit: rules.sessionMaxBytes, windowMs: rules.windowMs };
      try {
        // M4-05: a session whose model budget is spent queues no extraction; refused before anything.
        await assertSessionModelBudget(repo.db, ctx.sessionId);
        // Every attempt counts against the file cap, before the body is read.
        const files = await hitRateLimit(repo.db, filesKey, filesRule, at);
        if (!files.allowed) throw documentRejected("SESSION_CAP", files.retryAfterSeconds);

        let form: MultipartForm;
        try {
          form = await multipart();
        } catch (error) {
          if (error instanceof HttpProblem && error.code === "PAYLOAD_TOO_LARGE") {
            throw documentRejected("TOO_LARGE");
          }
          throw error;
        }
        const { file, kind } = parseForm(form);
        const bytes = file.bytes;
        facts.size = bytes.byteLength;
        facts.sha256 = sha256Hex(bytes);

        const inspected = inspectDocumentBytes(bytes);
        if (!inspected.ok) throw documentRejected(inspected.reason);
        if (inspected.mime === "application/pdf") {
          const pdf = await checkPdf(bytes);
          if (!pdf.ok) throw documentRejected(pdf.reason);
        }
        const filename = sanitizeFilename(file.name, inspected.ext);

        const byteCount = await hitRateLimit(repo.db, bytesKey, bytesRule, at, bytes.byteLength);
        if (!byteCount.allowed) {
          await refundRateLimit(repo.db, bytesKey, bytesRule, at, bytes.byteLength);
          throw documentRejected("SESSION_CAP", byteCount.retryAfterSeconds);
        }

        const stored = await withTransaction(repo.db, async (tx) => {
          const txRepo = repoCtx(tx, repo.businessId);
          const result = await storeDocument(txRepo, {
            kind,
            filename,
            mime: inspected.mime,
            bytes,
          });
          await appendAudit(txRepo, {
            actorType: "user",
            actorId: ctx.userId,
            action: result.deduplicated
              ? DOCUMENT_AUDIT_ACTIONS.deduplicated
              : DOCUMENT_AUDIT_ACTIONS.uploaded,
            subject: `document:${result.document.id}`,
            data: {
              document_id: result.document.id,
              sha256: result.document.sha256,
              size: result.document.size,
              mime: result.document.mime,
              kind: result.document.kind,
            },
          });
          // M2-02: a new document of an extractable kind is queued for extraction, in the same
          // transaction as the row (ADR 0005). A deduplicated upload queues nothing.
          if (!result.deduplicated && extractionTypeOf(result.document.kind)) {
            await enqueueDocumentExtraction(tx, {
              businessId: repo.businessId,
              documentId: result.document.id,
              ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
            });
          }
          return result;
        });
        const body: DocumentUploadResponse = {
          ...toMeta(stored.document),
          deduplicated: stored.deduplicated,
        };
        return Response.json(body, {
          status: stored.deduplicated ? 200 : 201,
          headers: { ...NO_STORE, location: `/api/v1/documents/${stored.document.id}` },
        });
      } catch (error) {
        await auditRejection(repo, ctx, error, facts);
        throw error;
      }
    },
  };

  const download: DocumentRouteSpecs["download"] = {
    method: "GET",
    auth: "session",
    params: idParams,
    handler: async ({ ctx, repo, params: { id } }) => {
      const content = await getDocumentContent(repo, id);
      if (!content) throw notFound();
      const { document: d, bytes } = content;
      await appendAudit(repo, {
        actorType: "user",
        actorId: ctx.userId,
        action: DOCUMENT_AUDIT_ACTIONS.downloaded,
        subject: `document:${d.id}`,
        data: { document_id: d.id, sha256: d.sha256, size: d.size },
      });
      return new Response(bytes.slice(), {
        status: 200,
        headers: {
          "content-type": d.mime,
          "content-length": String(bytes.byteLength),
          // The sanitised name holds only [A-Za-z0-9 ._()-]: safe inside the quotes.
          "content-disposition": `attachment; filename="${d.filename}"`,
          "x-content-type-options": "nosniff",
          ...NO_STORE,
        },
      });
    },
  };

  const meta: DocumentRouteSpecs["meta"] = {
    method: "GET",
    auth: "session",
    params: idParams,
    handler: async ({ repo, params: { id } }) => {
      const d = await getDocument(repo, id);
      if (!d) throw notFound();
      return Response.json(toMeta(d), { headers: NO_STORE });
    },
  };

  return { upload, download, meta };
}
