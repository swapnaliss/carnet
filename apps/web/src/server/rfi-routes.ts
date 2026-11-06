// The RFI routes' specs (M2-04). The route.ts files pass them to `defineRoute`; tests pass them to a kit
// built over test guards, so the exact production specs are what the cross-tenant tests exercise.
import {
  appendAudit,
  getRfi,
  linkRfiToPayment,
  listRfiQuestions,
  listRfis,
  repoCtx,
  unlinkRfi,
  withTransaction,
} from "@carnet/db";
import { PaymentIdSchema, RfiIdSchema } from "@carnet/domain";
import { z } from "zod";
import type { AuthRule, RouteSpec } from "../lib/define-route";
import { notFound } from "../lib/errors";
import { rfiJson, rfiQuestionJson } from "./rfis";

type Schema = z.ZodType | undefined;
const routeSpec = <A extends AuthRule, B extends Schema, Q extends Schema, P extends Schema>(
  spec: RouteSpec<A, B, Q, P>,
) => spec;

/** GET /api/v1/rfis: `?orphan=true` is the orphan (account-level) queue, `?orphan=false` linked only. */
export const rfiListSpec = routeSpec({
  method: "GET",
  auth: "session",
  query: z.strictObject({
    orphan: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  handler: async ({ repo, query }) => {
    const items = await listRfis(repo, {
      ...(query.orphan === undefined ? {} : { orphan: query.orphan === "true" }),
      limit: query.limit,
    });
    return Response.json({ items: items.map(rfiJson) });
  },
});

/** GET /api/v1/rfis/{id}: the RFI with its questions (all rounds). Another business's id is 404. */
export const rfiGetSpec = routeSpec({
  method: "GET",
  auth: "session",
  params: z.strictObject({ id: RfiIdSchema }),
  handler: async ({ repo, params }) => {
    const rfi = await getRfi(repo, params.id);
    if (!rfi) throw notFound();
    const questions = await listRfiQuestions(repo, rfi.id);
    return Response.json({ ...rfiJson(rfi), questions: questions.map(rfiQuestionJson) });
  },
});

/**
 * POST /api/v1/rfis/{id}/link: an owner or approver links an RFI (usually from the orphan queue) to one
 * of this business's payments, or removes the link with `{ payment_id: null }`. Audited either way. The
 * RFI's state is untouched and no payment status is written: the payment's held flag follows from the
 * link through project(transferStatus, openRfi) (ADR 0006).
 */
export const rfiLinkSpec = routeSpec({
  method: "POST",
  auth: { roles: ["owner", "approver"] as const },
  params: z.strictObject({ id: RfiIdSchema }),
  body: z.strictObject({ payment_id: PaymentIdSchema.nullable() }),
  handler: async ({ ctx, repo, params, body }) =>
    withTransaction(repo.db, async (tx) => {
      const rc = repoCtx(tx, repo.businessId);
      const result =
        body.payment_id === null
          ? await unlinkRfi(rc, params.id)
          : await linkRfiToPayment(rc, params.id, body.payment_id);
      // Unknown RFI, or an RFI/payment of another business: both are 404, never a hint which.
      if (!result) throw notFound();
      await appendAudit(rc, {
        actorType: "user",
        actorId: ctx.userId,
        action: body.payment_id === null ? "rfi.unlinked" : "rfi.linked",
        subject: `rfi:${result.after.id}`,
        data: {
          by: "owner",
          from: result.before.paymentId,
          paymentId: result.after.paymentId,
          orphanReason: result.after.orphanReason,
        },
      });
      return Response.json(rfiJson(result.after));
    }),
});
