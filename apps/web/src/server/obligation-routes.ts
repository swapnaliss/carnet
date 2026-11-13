// Obligations API (M3-01, ADR 0004, 0011).
//
//   GET  /api/v1/obligations                              any signed-in user
//   POST /api/v1/obligations                              owner/approver: create
//   GET  /api/v1/obligations/{id}                         any signed-in user; 404 for another business's
//   POST /api/v1/obligations/{id}/criticality/propose     owner/approver: queue the model's reading of a
//                                                         contract (202); it only ever stores a proposal
//   POST /api/v1/obligations/{id}/criticality/confirm     owner/approver: the one way a criticality is set;
//                                                         records the user, the time and the proposal seen
//
// A proposal never changes `criticality`; the planner reads `planning_criticality`, which is the confirmed
// value or `UNCONFIRMED`. Every query is scoped by the session's business.
import {
  appendAudit,
  type CriticalityProposal,
  confirmCriticality,
  createObligation,
  ForeignKeyViolationError,
  getCounterparty,
  getDocument,
  getLatestCriticalityProposal,
  getObligation,
  getPayment,
  listObligations,
  type Obligation,
  ProposalNotFoundError,
  type RepoCtx,
  repoCtx,
  withTransaction,
} from "@carnet/db";
import type { CounterpartyId, DocumentId, PaymentId } from "@carnet/domain";
import {
  ConfirmCriticalityBodySchema,
  CRITICALITY_AUDIT_ACTIONS,
  CRITICALITY_REJECT_MESSAGE,
  CreateObligationBodySchema,
  type CriticalityProposalView,
  ListObligationsQuerySchema,
  ObligationIdSchema,
  type ObligationView,
  ProposeCriticalityBodySchema,
  type ProposeCriticalityResponse,
  planningCriticality,
} from "@carnet/domain";
import { z } from "zod";
import type { AuthRule, RouteSpec } from "../lib/define-route";
import { notFound, validationFailed } from "../lib/errors";
import { enqueueCriticalityProposal } from "./obligations/jobs";

const idParams = z.strictObject({ id: ObligationIdSchema });
const NO_STORE = { "cache-control": "private, no-store" } as const;
const ROLES = { roles: ["owner", "approver"] } as const;

export function toProposalView(p: CriticalityProposal): CriticalityProposalView {
  const rejected = p.verifierResult === "REJECTED";
  return {
    id: p.id,
    obligation_id: p.obligationId,
    document_id: p.documentId,
    // A rejected proposal carries no value and none of the model's words: the owner sees why instead.
    proposed_criticality: rejected ? null : p.proposedCriticality,
    rationale: rejected ? "" : p.rationale,
    quote: rejected ? "" : p.quote,
    quote_page: rejected ? null : p.quotePage,
    verifier_result: p.verifierResult,
    verifier_reason: p.verifierReason,
    message: p.verifierReason ? CRITICALITY_REJECT_MESSAGE[p.verifierReason] : null,
    status: p.status,
    injection_suspected: p.injectionSuspected,
    injection_flags: p.injectionFlags.map((f) => ({ kind: f.kind, rule: f.rule, match: f.match })),
    prompt_version: p.promptVersion,
    created_at: p.createdAt.toISOString(),
  };
}

export function toObligationView(
  o: Obligation,
  latest: CriticalityProposal | null,
): ObligationView {
  return {
    id: o.id,
    business_id: o.businessId,
    counterparty_id: o.counterpartyId,
    amount_minor: o.amountMinor.toString(),
    currency: o.currency,
    due_at: o.dueAt.toISOString(),
    criticality: o.criticality,
    planning_criticality: planningCriticality(o),
    criticality_confirmed_by: o.criticalityConfirmedBy,
    criticality_confirmed_at: o.criticalityConfirmedAt?.toISOString() ?? null,
    criticality_confirmed_proposal_id: o.criticalityConfirmedProposalId,
    payment_id: o.paymentId,
    source_document_id: o.sourceDocumentId,
    created_at: o.createdAt.toISOString(),
    latest_proposal: latest ? toProposalView(latest) : null,
  };
}

async function viewOf(repo: RepoCtx, o: Obligation): Promise<ObligationView> {
  return toObligationView(o, await getLatestCriticalityProposal(repo, o.id));
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

export const obligationSpecs = {
  list: routeSpec({
    method: "GET",
    auth: "session",
    query: ListObligationsQuerySchema,
    handler: async ({ repo, query }) => {
      const rows = await listObligations(repo, query.limit);
      const items = await Promise.all(rows.map((o) => viewOf(repo, o)));
      return Response.json({ items }, { headers: NO_STORE });
    },
  }),

  create: routeSpec({
    method: "POST",
    auth: ROLES,
    body: CreateObligationBodySchema,
    handler: async ({ ctx, repo, body }) => {
      // Each referenced row must be this business's own: another business's id is a 404.
      if (!(await getCounterparty(repo, body.counterparty_id as CounterpartyId))) throw notFound();
      if (body.payment_id && !(await getPayment(repo, body.payment_id as PaymentId)))
        throw notFound();
      if (
        body.source_document_id &&
        !(await getDocument(repo, body.source_document_id as DocumentId))
      ) {
        throw notFound();
      }
      try {
        const created = await withTransaction(repo.db, async (tx) => {
          const rc = repoCtx(tx, repo.businessId);
          const o = await createObligation(rc, {
            counterpartyId: body.counterparty_id,
            amountMinor: BigInt(body.amount_minor),
            currency: body.currency,
            dueAt: new Date(body.due_at),
            paymentId: body.payment_id ?? null,
            sourceDocumentId: body.source_document_id ?? null,
          });
          await appendAudit(rc, {
            actorType: "user",
            actorId: ctx.userId,
            action: CRITICALITY_AUDIT_ACTIONS.created,
            subject: `obligation:${o.id}`,
            data: {
              amount_minor: body.amount_minor,
              currency: body.currency,
              due_at: o.dueAt.toISOString(),
            },
          });
          return o;
        });
        return Response.json(toObligationView(created, null), {
          status: 201,
          headers: { ...NO_STORE, location: `/api/v1/obligations/${created.id}` },
        });
      } catch (error) {
        if (error instanceof ForeignKeyViolationError) throw notFound();
        throw error;
      }
    },
  }),

  get: routeSpec({
    method: "GET",
    auth: "session",
    params: idParams,
    handler: async ({ repo, params: { id } }) => {
      const o = await getObligation(repo, id);
      if (!o) throw notFound();
      return Response.json(await viewOf(repo, o), { headers: NO_STORE });
    },
  }),

  propose: routeSpec({
    method: "POST",
    auth: ROLES,
    params: idParams,
    body: ProposeCriticalityBodySchema,
    handler: async ({ ctx, repo, params: { id }, body }) => {
      const o = await getObligation(repo, id);
      if (!o) throw notFound();
      const documentId = body.document_id ?? o.sourceDocumentId;
      if (!documentId) {
        throw validationFailed([
          {
            location: "body",
            path: "document_id",
            code: "required",
            message: "Name the contract to read: this obligation has no source document.",
          },
        ]);
      }
      const doc = await getDocument(repo, documentId as DocumentId);
      if (!doc) throw notFound();
      if (doc.kind !== "contract") {
        throw validationFailed([
          {
            location: "body",
            path: "document_id",
            code: "not_a_contract",
            message: "Only a contract can support a criticality proposal.",
          },
        ]);
      }
      await withTransaction(repo.db, async (tx) => {
        const rc = repoCtx(tx, repo.businessId);
        await appendAudit(rc, {
          actorType: "user",
          actorId: ctx.userId,
          action: CRITICALITY_AUDIT_ACTIONS.proposeRequested,
          subject: `obligation:${id}`,
          data: { document_id: documentId },
        });
        await enqueueCriticalityProposal(tx, {
          businessId: repo.businessId,
          obligationId: id,
          documentId,
        });
      });
      const response: ProposeCriticalityResponse = {
        obligation_id: id,
        document_id: documentId,
        status: "QUEUED",
      };
      return Response.json(response, { status: 202, headers: NO_STORE });
    },
  }),

  confirm: routeSpec({
    method: "POST",
    auth: ROLES,
    params: idParams,
    body: ConfirmCriticalityBodySchema,
    handler: async ({ ctx, repo, params: { id }, body }) => {
      const at = new Date();
      try {
        const result = await withTransaction(repo.db, async (tx) => {
          const rc = repoCtx(tx, repo.businessId);
          const before = await getObligation(rc, id);
          if (!before) return null;
          const done = await confirmCriticality(rc, {
            obligationId: id,
            criticality: body.criticality,
            userId: ctx.userId,
            proposalId: body.proposal_id ?? null,
            at,
          });
          if (!done) return null;
          await appendAudit(rc, {
            actorType: "user",
            actorId: ctx.userId,
            action: CRITICALITY_AUDIT_ACTIONS.confirmed,
            subject: `obligation:${id}`,
            data: {
              from: before.criticality,
              criticality: body.criticality,
              proposal_id: body.proposal_id ?? null,
              proposal_status: done.proposal?.status ?? null,
              proposed_criticality: done.proposal?.proposedCriticality ?? null,
            },
          });
          return done;
        });
        if (!result) throw notFound();
        return Response.json(
          toObligationView(result.obligation, await getLatestCriticalityProposal(repo, id)),
          {
            headers: NO_STORE,
          },
        );
      } catch (error) {
        if (error instanceof ProposalNotFoundError) {
          throw validationFailed([
            {
              location: "body",
              path: "proposal_id",
              code: "unknown_proposal",
              message: "That proposal does not belong to this obligation.",
            },
          ]);
        }
        throw error;
      }
    },
  }),
};
