// Document facts API (M2-02, ADR 0010).
//
//   GET  /api/v1/documents/{id}/facts                    every version (newest first) + the usable facts
//   POST /api/v1/documents/{id}/facts/{version}/confirm  an owner confirms the latest version, with
//                                                        optional corrections; inserts version n+1
//
// A fact is evidence only when it is verified against the document or an owner confirmed it. The
// confirming user is stored on the new version (`owner_confirmed_by`). Older versions never change.
import {
  appendAudit,
  FactsVersionConflictError,
  getDocument,
  getFactsVersion,
  getLatestFacts,
  getUsableFacts,
  insertFactsVersion,
  listFactVersions,
  repoCtx,
  type StoredFactsVersion,
  withTransaction,
} from "@carnet/db";
import {
  applyCorrections,
  ConfirmFactsBodySchema,
  DOCUMENT_AUDIT_ACTIONS,
  DocumentIdSchema,
  extractionTypeOf,
  type FactsListResponse,
  type FactsVersion,
} from "@carnet/domain";
import { z } from "zod";
import type { RouteSpec } from "../../lib/define-route";
import { conflict, type FieldIssue, notFound, validationFailed } from "../../lib/errors";
import { publishDocumentExtracted } from "./jobs";

const idParams = z.strictObject({ id: DocumentIdSchema });
const confirmParams = z.strictObject({
  id: DocumentIdSchema,
  version: z.coerce.number().int().min(1).max(100_000),
});
type IdParams = typeof idParams;
type ConfirmParams = typeof confirmParams;
type ConfirmBody = typeof ConfirmFactsBodySchema;

export interface FactsRouteSpecs {
  readonly list: RouteSpec<"session", undefined, undefined, IdParams>;
  readonly confirm: RouteSpec<
    { readonly roles: readonly ["owner"] },
    ConfirmBody,
    undefined,
    ConfirmParams
  >;
}

/** The API shape of a stored version. */
export function toFactsVersionView(v: StoredFactsVersion): FactsVersion {
  return {
    document_id: v.documentId,
    version: v.version,
    source: v.source,
    status: v.status,
    failure: v.failure,
    prompt_version: v.promptVersion,
    model: v.model,
    text_layer: v.textLayer,
    facts: [...v.facts],
    quotes: [...v.quotes],
    quotes_verified: v.quotesVerified,
    owner_confirmed_by: v.ownerConfirmedBy,
    injection_flags: [...v.injectionFlags],
    created_at: v.createdAt.toISOString(),
  };
}

const NO_STORE = { "cache-control": "private, no-store" } as const;

export function factsRouteSpecs(): FactsRouteSpecs {
  const list: FactsRouteSpecs["list"] = {
    method: "GET",
    auth: "session",
    params: idParams,
    handler: async ({ repo, params: { id } }) => {
      if (!(await getDocument(repo, id))) throw notFound();
      const [versions, usable] = await Promise.all([
        listFactVersions(repo, id),
        getUsableFacts(repo, id),
      ]);
      const body: FactsListResponse = {
        document_id: id,
        versions: versions.map(toFactsVersionView),
        usable,
      };
      return Response.json(body, { headers: NO_STORE });
    },
  };

  const confirm: FactsRouteSpecs["confirm"] = {
    method: "POST",
    auth: { roles: ["owner"] },
    params: confirmParams,
    body: ConfirmFactsBodySchema,
    handler: async ({ ctx, repo, params: { id, version }, body }) => {
      const document = await getDocument(repo, id);
      if (!document) throw notFound();
      const type = extractionTypeOf(document.kind);
      if (!type) {
        throw validationFailed([
          {
            location: "params",
            path: "id",
            code: "unsupported_kind",
            message: "This kind of document has no extracted facts.",
          },
        ]);
      }
      const target = await getFactsVersion(repo, id, version);
      if (!target) throw notFound();
      const latest = await getLatestFacts(repo, id);
      if (!latest || latest.version !== target.version) {
        throw conflict("There is a newer version of these facts. Reload and review it.");
      }
      const corrections = body.corrections ?? [];
      if (target.ownerConfirmedBy !== null && corrections.length === 0) {
        throw conflict("These facts are already confirmed.");
      }
      const applied = applyCorrections(type, target.facts, corrections);
      if (!applied.ok) {
        throw validationFailed(
          applied.problems.map(
            (p): FieldIssue => ({
              location: "body",
              path: `corrections.${p.index}`,
              code: p.code,
              message:
                p.code === "unknown_key"
                  ? `"${p.key}" is not a fact of this kind of document.`
                  : `The value for "${p.key}" is not a valid ${p.key} value.`,
            }),
          ),
        );
      }
      if (applied.facts.length === 0) {
        throw validationFailed([
          {
            location: "body",
            path: "corrections",
            code: "required",
            message: "Enter the values to confirm: this version has no facts.",
          },
        ]);
      }
      try {
        const stored = await withTransaction(repo.db, async (tx) => {
          const txRepo = repoCtx(tx, repo.businessId);
          const result = await insertFactsVersion(txRepo, {
            documentId: id,
            source: "owner",
            status: "EXTRACTED",
            textLayer: target.textLayer,
            promptVersion: target.promptVersion,
            model: target.model,
            facts: applied.facts,
            injectionFlags: target.injectionFlags,
            ownerConfirmedBy: ctx.userId,
          });
          await appendAudit(txRepo, {
            actorType: "user",
            actorId: ctx.userId,
            action: DOCUMENT_AUDIT_ACTIONS.factsConfirmed,
            subject: `document:${id}`,
            data: {
              document_id: id,
              from_version: target.version,
              version: result.version.version,
              corrections: corrections.length,
            },
          });
          await publishDocumentExtracted(tx, {
            businessId: repo.businessId,
            documentId: id,
            version: result.version.version,
            source: "owner",
            status: "EXTRACTED",
          });
          return result.version;
        });
        return Response.json(toFactsVersionView(stored), {
          status: 201,
          headers: { ...NO_STORE, location: `/api/v1/documents/${id}/facts` },
        });
      } catch (error) {
        if (error instanceof FactsVersionConflictError) throw conflict();
        throw error;
      }
    },
  };

  return { list, confirm };
}
