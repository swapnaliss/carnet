// Owner API for payee status links (M3-06): /api/v1/payments/{id}/payee-links.
//   GET    list                         any signed-in user (a viewer may read; there is no token in it)
//   POST   create                       owner/approver, `Idempotency-Key` required
//   DELETE /{linkId}  revoke            owner/approver
// The raw token is in the create response once and nowhere else: not stored, not in the idempotency
// record (a replay returns the link without the address and says so), not in the audit log.
// Nothing here sends anything to anyone: the owner copies the link.
import { createHash } from "node:crypto";
import {
  appendAudit,
  createPayeeLink,
  DuplicateIdempotencyKeyError,
  getIdempotencyRecord,
  getPayment,
  listPayeeLinks,
  type PayeeLink,
  repoCtx,
  revokePayeeLink,
  saveIdempotencyRecord,
  withTransaction,
} from "@carnet/db";
import { DISCLOSURE_LEVELS, PaymentIdSchema } from "@carnet/domain";
import { z } from "zod";
import type { AuthRule, RouteSpec } from "../lib/define-route";
import { conflict, HttpProblem, notFound } from "../lib/errors";
import {
  defaultPayeeLinkTtlHours,
  hashPayeeToken,
  MAX_PAYEE_LINK_TTL_HOURS,
  newPayeeToken,
} from "./payee-status";

export const PAYEE_LINKS_ENDPOINT = "POST /api/v1/payments/{id}/payee-links";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

const params = z.strictObject({ id: PaymentIdSchema });
const linkParams = z.strictObject({ id: PaymentIdSchema, linkId: z.uuid() });

export const CreatePayeeLinkBodySchema = z.strictObject({
  disclosure_level: z.enum(DISCLOSURE_LEVELS).default("GENERIC"),
  expires_in_hours: z.int().min(1).max(MAX_PAYEE_LINK_TTL_HOURS).optional(),
});

export type PayeeLinkState = "active" | "expired" | "revoked";

export function payeeLinkJson(link: PayeeLink, now: Date) {
  const state: PayeeLinkState =
    link.revokedAt !== null ? "revoked" : link.expiresAt <= now ? "expired" : "active";
  return {
    id: link.id,
    payment_id: link.paymentId,
    disclosure_level: link.disclosureLevel,
    state,
    expires_at: link.expiresAt.toISOString(),
    revoked_at: link.revokedAt?.toISOString() ?? null,
    created_at: link.createdAt.toISOString(),
    last_viewed_at: link.lastViewedAt?.toISOString() ?? null,
  };
}

export interface CreateResponse {
  readonly link: ReturnType<typeof payeeLinkJson>;
  /** The status path (`/status/<token>`), only in the response that created the link. */
  readonly path: string | null;
  readonly replayed: boolean;
}

function idempotencyKeyOf(req: Request): string {
  const key = req.headers.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new HttpProblem(
      "VALIDATION_FAILED",
      "Send an Idempotency-Key header of 8 to 128 characters (letters, digits, . _ : -).",
      { details: { header: "Idempotency-Key" } },
    );
  }
  return key;
}

type Schema = z.ZodType | undefined;
/** Identity helper: gives each handler the typed input `defineRoute` would (route and tests share it). */
function routeSpec<
  const A extends AuthRule,
  B extends Schema = undefined,
  Q extends Schema = undefined,
  P extends Schema = undefined,
>(spec: RouteSpec<A, B, Q, P>): RouteSpec<A, B, Q, P> {
  return spec;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export const payeeLinkSpecs = {
  list: routeSpec({
    method: "GET",
    auth: "session",
    params,
    handler: async ({ repo, params: { id } }) => {
      if (!(await getPayment(repo, id))) throw notFound();
      const links = await listPayeeLinks(repo, id);
      const now = new Date();
      return Response.json({ items: links.map((l) => payeeLinkJson(l, now)) });
    },
  }),
  create: routeSpec({
    method: "POST",
    auth: { roles: ["owner", "approver"] },
    params,
    body: CreatePayeeLinkBodySchema,
    handler: async ({ req, ctx, repo, params: { id }, body }) => {
      const key = idempotencyKeyOf(req);
      const hours = body.expires_in_hours ?? defaultPayeeLinkTtlHours();
      const requestHash = sha256(
        JSON.stringify({ id, level: body.disclosure_level, hours: body.expires_in_hours ?? null }),
      );
      const now = new Date();

      try {
        const result = await withTransaction(repo.db, async (tx) => {
          const tctx = repoCtx(tx, repo.businessId);
          const prior = await getIdempotencyRecord(tctx, PAYEE_LINKS_ENDPOINT, key);
          if (prior) {
            if (prior.requestHash !== requestHash) {
              throw new HttpProblem(
                "IDEMPOTENCY_KEY_REUSED",
                "This Idempotency-Key was used for a different request.",
              );
            }
            const replay = prior.response as CreateResponse;
            return { status: prior.responseStatus, response: { ...replay, replayed: true } };
          }
          const token = newPayeeToken();
          const link = await createPayeeLink(tctx, {
            paymentId: id,
            tokenHash: hashPayeeToken(token),
            expiresAt: new Date(now.getTime() + hours * 3_600_000),
            disclosureLevel: body.disclosure_level,
            createdBy: ctx.userId,
          });
          if (!link) throw notFound();
          const response: CreateResponse = {
            link: payeeLinkJson(link, now),
            path: `/status/${token}`,
            replayed: false,
          };
          await saveIdempotencyRecord(tctx, {
            endpoint: PAYEE_LINKS_ENDPOINT,
            key,
            requestHash,
            responseStatus: 201,
            // The address is never stored, so a replay cannot return it.
            response: { ...response, path: null },
          });
          await appendAudit(tctx, {
            actorType: "user",
            actorId: ctx.userId,
            action: "payee_link.created",
            subject: `payment:${id}`,
            data: {
              link_id: link.id,
              disclosure_level: link.disclosureLevel,
              expires_at: link.expiresAt.toISOString(),
            },
          });
          return { status: 201, response };
        });
        return Response.json(result.response, { status: result.status });
      } catch (error) {
        if (error instanceof DuplicateIdempotencyKeyError) {
          throw conflict("A request with this Idempotency-Key is already being processed.");
        }
        throw error;
      }
    },
  }),
  revoke: routeSpec({
    method: "DELETE",
    auth: { roles: ["owner", "approver"] },
    params: linkParams,
    handler: async ({ ctx, repo, params: { id, linkId } }) => {
      const now = new Date();
      const link = await withTransaction(repo.db, async (tx) => {
        const tctx = repoCtx(tx, repo.businessId);
        const revoked = await revokePayeeLink(tctx, id, linkId, now);
        if (!revoked) throw notFound();
        await appendAudit(tctx, {
          actorType: "user",
          actorId: ctx.userId,
          action: "payee_link.revoked",
          subject: `payment:${id}`,
          data: { link_id: linkId },
        });
        return revoked;
      });
      return Response.json({ link: payeeLinkJson(link, now) });
    },
  }),
};
