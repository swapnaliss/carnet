// Payments API (M1-08, ADR 0004/0006/0007). The route files only bind these handlers:
//
//   GET  /api/v1/payments                 any session      → { items: PaymentDto[], server_time }
//   POST /api/v1/payments                 owner            → 201 { payment } (Idempotency-Key)
//   GET  /api/v1/payments/{id}            any session      → { payment, webhooks, server_time }
//   POST /api/v1/payments/{id}/simulate   owner            → 202 { queued, next_status }
//
// Create: check the sandbox balance (one read, no retry), then ONE transaction writes the payment,
// its transfer ExecutionAttempt (INTENT, fresh request_id), the `transfer.create` outbox job and the
// idempotency record. The Airwallex call happens in the worker, never in the request. A replayed key
// returns the stored response; the same key with a different body is IDEMPOTENCY_KEY_REUSED.
// Status is the projection of the stored transfer status (`project()`); it is never invented here.
import { createHash } from "node:crypto";
import {
  createPayment,
  DuplicateIdempotencyKeyError,
  type ExecutionAttempt,
  enqueueJob,
  getBusiness,
  getCounterparty,
  getIdempotencyRecord,
  getPayment,
  type IdempotencyRecord,
  listAttemptsForRefs,
  listCounterparties,
  listPayments,
  listRfis,
  listWebhookEventsForPayment,
  type Payment,
  type PaymentWebhookEvent,
  paymentHasHoldingRfi,
  type RepoCtx,
  repoCtx,
  saveIdempotencyRecord,
  withTransaction,
} from "@carnet/db";
import {
  type CreatePaymentBody,
  CreatePaymentBodySchema,
  formatMajor,
  IdempotencyKeySchema,
  type Money,
  type MoneyWire,
  type PaymentId,
  PaymentIdSchema,
  type PaymentView,
  parseEvidencePolicy,
  project,
  RFI_HOLDING_STATES,
  SendPaymentBodySchema,
  SimulateTransferBodySchema,
  toMoneyWire,
} from "@carnet/domain";
import { z } from "zod";
import type { Role } from "../lib/authz";
import type { AuthRule, createRouteKit, RouteSpec } from "../lib/define-route";
import { conflict, HttpProblem, notFound } from "../lib/errors";
import { JOB_KIND } from "../worker/handlers/index";
import type { BalanceReader } from "./airwallex";
import {
  ackProblem,
  createSendProblem,
  isSent,
  loadEvidenceCheck,
  sendWithGuard,
} from "./evidence";

export const CREATE_ENDPOINT = "POST /api/v1/payments";
/** The UI polls every 3 s (ADR 0017); the list shows at most this many payments. */
export const PAYMENT_LIST_LIMIT = 50;

export interface AttemptDto {
  readonly id: string;
  readonly status: ExecutionAttempt["status"];
  readonly request_id: string;
  /** Commit time of the INTENT row (written with the payment, before any outbound call). */
  readonly created_at: string;
  /** When the worker committed SENT_TO_AIRWALLEX, just before calling Airwallex. */
  readonly sent_at: string | null;
  readonly confirmed_at: string | null;
  readonly sends: number;
  readonly error: {
    readonly kind: string;
    readonly code?: string;
    readonly message: string;
  } | null;
}

export interface PaymentDto {
  readonly id: string;
  readonly reference: string;
  readonly amount: MoneyWire;
  readonly source_currency: string;
  readonly method: string;
  readonly counterparty_id: string | null;
  readonly transfer_id: string | null;
  readonly transfer_status: string | null;
  readonly transfer_updated_at: string | null;
  readonly failure_type: string | null;
  /** `project(transfer_status, openRfi)`; null until Airwallex reports a transfer. */
  readonly view: PaymentView | null;
  readonly held: boolean;
  readonly final: boolean;
  readonly attempt: AttemptDto | null;
  readonly created_at: string;
  /** Changes whenever the worker stores a new transfer state. */
  readonly updated_at: string;
}

export interface WebhookDto {
  readonly id: string;
  readonly event_id: string;
  readonly name: string;
  readonly signature_ok: boolean;
  readonly received_at: string;
  readonly acked_at: string | null;
  readonly processed_at: string | null;
  /** Only for the owner: the body exactly as Airwallex delivered it. */
  readonly raw_body?: string;
}

export interface PaymentListResponse {
  readonly items: PaymentDto[];
  readonly server_time: string;
}

export interface PaymentDetailResponse {
  readonly payment: PaymentDto;
  readonly webhooks: WebhookDto[];
  readonly server_time: string;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

export function attemptDto(attempt: ExecutionAttempt): AttemptDto {
  const r = (
    typeof attempt.response === "object" && attempt.response !== null ? attempt.response : {}
  ) as Record<string, unknown>;
  const e = r.error as Record<string, unknown> | undefined;
  return {
    id: attempt.id,
    status: attempt.status,
    request_id: attempt.requestId,
    created_at: attempt.createdAt.toISOString(),
    sent_at: str(r.sentAt),
    confirmed_at: str(r.confirmedAt),
    sends: typeof r.sends === "number" ? r.sends : 0,
    error:
      e && typeof e.message === "string"
        ? {
            kind: str(e.kind) ?? "Error",
            ...(typeof e.code === "string" ? { code: e.code } : {}),
            message: e.message,
          }
        : null,
  };
}

/**
 * `openRfi` is whether a holding RFI is linked to the payment (RFI_HOLDING_STATES, as the queue reads it).
 * It only decides `view` and `held` through `project()`; it never touches `transfer_status` (ADR 0006).
 */
export function paymentDto(
  payment: Payment,
  attempt: ExecutionAttempt | null,
  openRfi = false,
): PaymentDto {
  const projection = payment.transferStatus ? project(payment.transferStatus, openRfi) : null;
  return {
    id: payment.id,
    reference: payment.reference,
    amount: toMoneyWire(payment.amount),
    source_currency: payment.sourceCurrency,
    method: payment.method,
    counterparty_id: payment.counterpartyId,
    transfer_id: payment.transferId,
    transfer_status: payment.transferStatus,
    transfer_updated_at: iso(payment.transferUpdatedAt),
    failure_type: payment.failureType,
    view: projection?.view ?? null,
    held: projection?.held ?? false,
    final: projection?.final ?? false,
    attempt: attempt ? attemptDto(attempt) : null,
    created_at: payment.createdAt.toISOString(),
    updated_at: payment.updatedAt.toISOString(),
  };
}

function webhookDto(event: PaymentWebhookEvent, role: Role): WebhookDto {
  return {
    id: event.id,
    event_id: event.providerEventId,
    name: event.name,
    signature_ok: event.signatureOk,
    received_at: event.receivedAt.toISOString(),
    acked_at: iso(event.ackedAt),
    processed_at: iso(event.processedAt),
    ...(role === "owner" ? { raw_body: event.rawBody } : {}),
  };
}

/** The newest transfer attempt per payment. */
function latestAttempts(attempts: ExecutionAttempt[]): Map<string, ExecutionAttempt> {
  const out = new Map<string, ExecutionAttempt>();
  for (const a of attempts) out.set(a.refId, a); // oldest first, so the last one wins
  return out;
}

export async function loadPaymentList(
  repo: RepoCtx,
  now = new Date(),
): Promise<PaymentListResponse> {
  const payments = await listPayments(repo, { limit: PAYMENT_LIST_LIMIT });
  const attempts = latestAttempts(
    await listAttemptsForRefs(
      repo,
      "transfer",
      payments.map((p) => p.id),
    ),
  );
  const holding = new Set(
    (await listRfis(repo, { states: [...RFI_HOLDING_STATES], orphan: false })).map(
      (r) => r.paymentId,
    ),
  );
  return {
    items: payments.map((p) => paymentDto(p, attempts.get(p.id) ?? null, holding.has(p.id))),
    server_time: now.toISOString(),
  };
}

export async function loadPaymentDetail(
  repo: RepoCtx,
  id: PaymentId,
  role: Role,
  now = new Date(),
): Promise<PaymentDetailResponse | null> {
  const payment = await getPayment(repo, id);
  if (!payment) return null;
  const attempt = latestAttempts(await listAttemptsForRefs(repo, "transfer", [id])).get(id) ?? null;
  const webhooks = await listWebhookEventsForPayment(repo, id);
  return {
    payment: paymentDto(payment, attempt, await paymentHasHoldingRfi(repo, id)),
    webhooks: webhooks.map((w) => webhookDto(w, role)),
    server_time: now.toISOString(),
  };
}

/** Canonical form of a create body: the same request always hashes the same. */
export function requestHash(body: CreatePaymentBody): string {
  const canonical = JSON.stringify([
    formatMajor(body.amount),
    body.amount.currency,
    body.reference,
    body.counterparty_id ?? null,
    // Appended only for a draft, so the hash of every earlier "create and send" request is unchanged.
    ...(body.send === false ? ["draft"] : []),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

function idempotencyKeyOf(req: Request): string {
  const parsed = IdempotencyKeySchema.safeParse(req.headers.get("idempotency-key") ?? "");
  if (!parsed.success) {
    throw new HttpProblem(
      "VALIDATION_FAILED",
      "Send an Idempotency-Key header (8 to 128 visible characters). Nothing was created.",
    );
  }
  return parsed.data;
}

function replay(record: IdempotencyRecord, hash: string, requestId: string): Response {
  if (record.requestHash !== hash) {
    throw new HttpProblem(
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used for a different payment. Nothing was created.",
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

async function checkBalance(amount: Money, balances: BalanceReader): Promise<void> {
  let all: Awaited<ReturnType<BalanceReader>>;
  try {
    all = await balances();
  } catch {
    throw new HttpProblem(
      "UPSTREAM_ERROR",
      "Airwallex did not answer the balance check. Nothing was created. Try again in a moment.",
    );
  }
  const balance = all.find((b) => b.currency === amount.currency);
  const available = balance?.available.minor ?? 0n;
  if (available < amount.minor) {
    const have = balance ? formatMajor(balance.available) : "0";
    throw new HttpProblem(
      "PRECONDITION_FAILED",
      `Not enough ${amount.currency} in the sandbox wallet: ${have} available, ${formatMajor(amount)} needed. Nothing was created.`,
      {
        details: {
          reason: "insufficient_funds",
          available: { amount: have, currency: amount.currency },
          required: toMoneyWire(amount),
        },
      },
    );
  }
}

export async function createPaymentWithAttempt(
  repo: RepoCtx,
  body: CreatePaymentBody,
  key: string,
  deps: { balances: BalanceReader; requestId: string; userId: string },
): Promise<Response> {
  const hash = requestHash(body);
  // M2-03: `send: false` saves the payment without sending it; the owner adds documents, sees the
  // evidence check and sends from the evidence view (`POST .../send`). Otherwise create and send, behind
  // the same evidence guard.
  const send = body.send !== false;
  const existing = await getIdempotencyRecord(repo, CREATE_ENDPOINT, key);
  if (existing) return replay(existing, hash, deps.requestId);

  const counterparty = body.counterparty_id
    ? await getCounterparty(repo, body.counterparty_id)
    : ((await listCounterparties(repo))[0] ?? null);
  if (!counterparty) {
    if (body.counterparty_id) throw notFound();
    throw new HttpProblem(
      "PRECONDITION_FAILED",
      "This business has no counterparty to pay yet. Nothing was created.",
    );
  }
  if (send) {
    // The evidence guard answers before the balance is read: a payment with no documents is Missing.
    const policy = parseEvidencePolicy((await getBusiness(repo))?.evidencePolicy);
    const problem = createSendProblem(body.amount, counterparty.name, body.evidence_ack, policy);
    if (problem) throw problem;
    await checkBalance(body.amount, deps.balances);
  }

  try {
    const created = await withTransaction(repo.db, async (tx) => {
      const rc = repoCtx(tx, repo.businessId);
      const payment = await createPayment(rc, {
        counterpartyId: counterparty.id,
        amount: body.amount,
        sourceCurrency: body.amount.currency,
        method: "LOCAL",
        reference: body.reference,
      });
      const attempt = send
        ? (await sendWithGuard(rc, payment.id, body.evidence_ack, { userId: deps.userId })).attempt
        : null;
      const response = { payment: paymentDto(payment, attempt) };
      await saveIdempotencyRecord(rc, {
        endpoint: CREATE_ENDPOINT,
        key,
        requestHash: hash,
        responseStatus: 201,
        response,
      });
      return response;
    });
    return Response.json(created, {
      status: 201,
      headers: { "cache-control": "no-store", "x-request-id": deps.requestId },
    });
  } catch (error) {
    // A concurrent request with the same key won the race; its transaction holds the payment.
    if (error instanceof DuplicateIdempotencyKeyError) {
      const winner = await getIdempotencyRecord(repo, CREATE_ENDPOINT, key);
      if (winner) return replay(winner, hash, deps.requestId);
    }
    throw error;
  }
}

const IdParams = z.strictObject({ id: PaymentIdSchema });

/** Keeps a spec's generics so a route file can pass it straight to `defineRoute`. */
function spec<
  A extends AuthRule,
  B extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  P extends z.ZodType | undefined = undefined,
>(s: RouteSpec<A, B, Q, P>): RouteSpec<A, B, Q, P> {
  return s;
}

/**
 * The four route specs. Route files declare `export const GET = defineRoute(specs.list)` (the M1-10
 * inventory requires `defineRoute(` in each file); tests build the same specs on a test kit.
 */
export function paymentRouteSpecs(deps: { balances: BalanceReader; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  const noStore = { "cache-control": "no-store" };

  const list = spec({
    method: "GET",
    auth: "session",
    handler: async ({ repo }) =>
      Response.json(await loadPaymentList(repo, now()), { headers: noStore }),
  });

  const create = spec({
    method: "POST",
    auth: { roles: ["owner"] },
    body: CreatePaymentBodySchema,
    maxBodyBytes: 4 * 1024,
    handler: async ({ req, ctx, repo, body, requestId }) =>
      createPaymentWithAttempt(repo, body, idempotencyKeyOf(req), {
        balances: deps.balances,
        requestId,
        userId: ctx.userId,
      }),
  });

  // M2-03: sends a saved payment. The evidence check runs in the same transaction; a Weak or Missing
  // payment needs the owner's acknowledgement (412 with the check otherwise). A payment that was
  // already sent answers 200 with `already_sent` and writes nothing.
  const send = spec({
    method: "POST",
    auth: { roles: ["owner"] },
    params: IdParams,
    body: SendPaymentBodySchema,
    maxBodyBytes: 2 * 1024,
    handler: async ({ ctx, repo, params, body, requestId }) => {
      const payment = await getPayment(repo, params.id);
      if (!payment) throw notFound();
      if (!(await isSent(repo, payment))) {
        // Evidence first, then money: a refused payment never reads the Airwallex balance.
        const loaded = await loadEvidenceCheck(repo, params.id);
        if (!loaded) throw notFound();
        const problem = ackProblem(loaded.check, loaded.dto, body.evidence_ack);
        if (problem) throw problem;
        await checkBalance(payment.amount, deps.balances);
      }
      const outcome = await withTransaction(repo.db, (tx) =>
        sendWithGuard(repoCtx(tx, repo.businessId), params.id, body.evidence_ack, {
          userId: ctx.userId,
        }),
      );
      const fresh = (await getPayment(repo, params.id)) ?? payment;
      return Response.json(
        {
          payment: paymentDto(fresh, outcome.attempt, await paymentHasHoldingRfi(repo, params.id)),
          already_sent: outcome.alreadySent,
          evidence: outcome.alreadySent
            ? null
            : {
                flag: outcome.flag,
                check_hash: outcome.checkHash,
                overridden: outcome.overridden,
              },
        },
        { headers: { ...noStore, "x-request-id": requestId } },
      );
    },
  });

  const detail = spec({
    method: "GET",
    auth: "session",
    params: IdParams,
    handler: async ({ repo, ctx, params }) => {
      const found = await loadPaymentDetail(repo, params.id, ctx.role, now());
      if (!found) throw notFound();
      return Response.json(found, { headers: noStore });
    },
  });

  const simulate = spec({
    method: "POST",
    auth: { roles: ["owner"] },
    params: IdParams,
    body: SimulateTransferBodySchema,
    maxBodyBytes: 1024,
    handler: async ({ repo, params, body }) => {
      const payment = await getPayment(repo, params.id);
      if (!payment) throw notFound();
      if (!payment.transferId) {
        throw conflict("This payment has no Airwallex transfer yet. Wait for it, then try again.");
      }
      const jobId = await enqueueJob(repo.db, {
        kind: JOB_KIND.transferSimulate,
        payload: {
          paymentId: payment.id,
          businessId: repo.businessId,
          nextStatus: body.next_status,
        },
      });
      return Response.json(
        { queued: true, next_status: body.next_status, job_id: jobId },
        { status: 202, headers: noStore },
      );
    },
  });

  return { list, create, detail, simulate, send };
}

/** The specs bound to a route kit (tests). */
export function createPaymentRoutes(
  kit: ReturnType<typeof createRouteKit>,
  deps: { balances: BalanceReader; now?: () => Date },
) {
  const s = paymentRouteSpecs(deps);
  return {
    list: kit.defineRoute(s.list),
    create: kit.defineRoute(s.create),
    detail: kit.defineRoute(s.detail),
    simulate: kit.defineRoute(s.simulate),
    send: kit.defineRoute(s.send),
  };
}
