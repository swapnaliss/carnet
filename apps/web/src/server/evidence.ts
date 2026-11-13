// Evidence API (M2-03, Pillar 1). The judgement is made by code from verified or owner-confirmed facts
// (packages/domain/src/evidence); nothing here calls a model.
//
//   GET    /api/v1/payments/{id}/evidence-check          any session → the check, its documents and facts
//   POST   /api/v1/payments/{id}/evidence-links          owner → attach a document; stores a check snapshot
//   DELETE /api/v1/payments/{id}/evidence-links/{linkId} owner → detach; stores a check snapshot
//   POST   /api/v1/payments/{id}/send                    owner → send (the guard below)
//
// The guard (`sendWithGuard`): a payment is never sent without the check having run in the same
// transaction. A Weak or Missing payment is refused (412, with the check) unless the owner sends an
// acknowledgement; the acknowledgement may be bound to the exact check the owner saw (`check_hash`), and
// an `evidence_override` audit entry then holds the flag, the reasons shown (keys, parameters and the
// sentences) and the fact versions. Nothing is blocked silently: the 412 carries the reasons.
import {
  appendAudit,
  attachEvidenceLink,
  createAttempt,
  type EvidenceContext,
  type EvidenceDocumentView,
  type ExecutionAttempt,
  enqueueJob,
  getPaymentForUpdate,
  insertEvidenceCheck,
  isExecutionEnabled,
  listAttemptsForRefs,
  loadEvidenceContext,
  type Payment,
  type RepoCtx,
  removeEvidenceLink,
  repoCtx,
  type StoredFactsVersion,
  withTransaction,
} from "@carnet/db";
import {
  AttachEvidenceBodySchema,
  checkEvidence,
  contractRequired,
  contractThreshold,
  EVIDENCE_AUDIT_ACTIONS,
  type EvidenceAck,
  type EvidenceCheck,
  type EvidencePolicy,
  type EvidenceReason,
  type Money,
  type MoneyWire,
  newRequestId,
  type PaymentId,
  PaymentIdSchema,
  parseEvidencePolicy,
  toMoneyWire,
} from "@carnet/domain";
import { z } from "zod";
import type { AuthRule, RouteSpec } from "../lib/define-route";
import { HttpProblem, notFound } from "../lib/errors";
import { fill, t } from "../strings";
import { JOB_KIND } from "../worker/handlers/index";

// ---------------------------------------------------------------------------------------------
// Wire shapes

export interface ReasonDto {
  readonly key: string;
  readonly params: Readonly<Record<string, string>>;
  /** The sentence, from the strings module. */
  readonly text: string;
}

export interface RuleDto {
  readonly rule: string;
  readonly outcome: "pass" | "fail" | "missing";
  readonly reasons: readonly ReasonDto[];
  readonly fact_version_ids: readonly string[];
}

export type FactStatus = "verified" | "needs_confirmation" | "confirmed" | "unverified";

export interface FactDto {
  readonly key: string;
  readonly value: string;
  readonly quote: string;
  readonly page: number;
  readonly status: FactStatus;
  /** True when a rule may use it (verified or confirmed). */
  readonly usable: boolean;
}

export interface EvidenceDocumentDto {
  readonly link_id: string;
  readonly document_id: string;
  readonly kind: string;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly sha256: string;
  readonly extraction: "none" | "pending" | "failed" | "done";
  readonly failure: string | null;
  readonly text_layer: boolean | null;
  /** The latest fact version number: the one `POST /documents/{id}/facts/{version}/confirm` takes. */
  readonly facts_version: number | null;
  readonly confirmed: boolean;
  readonly needs_confirmation: boolean;
  readonly facts: readonly FactDto[];
  readonly injection_flags: readonly { rule: string; match: string }[];
}

export interface EvidenceCheckDto {
  readonly payment: {
    readonly id: string;
    readonly reference: string;
    readonly amount: MoneyWire;
    readonly counterparty_name: string | null;
    readonly method: string;
    /** The stored beneficiary account fingerprint (opaque); null until a beneficiary exists. */
    readonly account_fingerprint: string | null;
    /** An attempt or a transfer exists: the payment has been sent. */
    readonly sent: boolean;
  };
  readonly flag: EvidenceCheck["flag"];
  readonly reasons: readonly ReasonDto[];
  readonly rules: readonly RuleDto[];
  readonly check_hash: string;
  readonly fact_version_ids: readonly string[];
  readonly contract_required: boolean;
  readonly contract_threshold: MoneyWire;
  readonly documents: readonly EvidenceDocumentDto[];
  readonly server_time: string;
}

export function reasonDto(reason: EvidenceReason): ReasonDto {
  const template = (t.evidence.reason as Record<string, string>)[reason.key] ?? reason.key;
  // A fact key (`invoice_number`) is shown as words ("invoice number").
  const params = reason.params.fact
    ? { ...reason.params, fact: reason.params.fact.replaceAll("_", " ") }
    : reason.params;
  return { key: reason.key, params, text: fill(template, { ...params }) };
}

function factStatus(v: StoredFactsVersion, fact: StoredFactsVersion["facts"][number]): FactStatus {
  if (v.ownerConfirmedBy !== null) return fact.parsed !== null ? "confirmed" : "unverified";
  if (fact.needs_confirmation) return "needs_confirmation";
  return fact.quote_verified && fact.parsed !== null ? "verified" : "unverified";
}

function documentDto(view: EvidenceDocumentView): EvidenceDocumentDto {
  const { document, latest } = view;
  const facts: FactDto[] = (latest?.facts ?? []).map((f) => {
    const status = factStatus(latest as StoredFactsVersion, f);
    return {
      key: f.key,
      value: f.value,
      quote: f.quote,
      page: f.page,
      status,
      usable: status === "verified" || status === "confirmed",
    };
  });
  return {
    link_id: view.link.id,
    document_id: document.id,
    kind: document.kind,
    filename: document.filename,
    mime: document.mime,
    size: document.size,
    sha256: document.sha256,
    extraction: view.extraction,
    failure: latest?.status === "EXTRACTION_FAILED" ? latest.failure : null,
    text_layer: latest ? latest.textLayer : null,
    facts_version: latest ? latest.version : null,
    confirmed: latest?.ownerConfirmedBy != null,
    needs_confirmation: facts.some((f) => f.status === "needs_confirmation"),
    facts,
    injection_flags: (latest?.injectionFlags ?? []).map((f) => ({ rule: f.rule, match: f.match })),
  };
}

export function checkDto(
  context: EvidenceContext,
  check: EvidenceCheck,
  sent: boolean,
  now = new Date(),
): EvidenceCheckDto {
  const { payment } = context;
  const threshold = contractThreshold(context.input.policy, payment.amount.currency);
  return {
    payment: {
      id: payment.id,
      reference: payment.reference,
      amount: toMoneyWire(payment.amount),
      counterparty_name: context.counterparty?.name ?? null,
      method: payment.method,
      account_fingerprint: context.counterparty?.accountFingerprint ?? null,
      sent,
    },
    flag: check.flag,
    reasons: check.reasons.map(reasonDto),
    rules: check.rules.map((r) => ({
      rule: r.rule,
      outcome: r.outcome,
      reasons: r.reasons.map(reasonDto),
      fact_version_ids: r.fact_version_ids,
    })),
    check_hash: check.check_hash,
    fact_version_ids: check.fact_version_ids,
    contract_required: contractRequired(context.input),
    contract_threshold: toMoneyWire({ minor: threshold, currency: payment.amount.currency }),
    documents: context.documents.map(documentDto),
    server_time: now.toISOString(),
  };
}

/** The attempt (or the transfer) that says the payment was sent. */
export async function isSent(repo: RepoCtx, payment: Payment): Promise<boolean> {
  if (payment.transferId !== null) return true;
  return (await listAttemptsForRefs(repo, "transfer", [payment.id])).length > 0;
}

/** Runs the pure check on the stored facts. Null when the payment is not in this business. */
export async function loadEvidenceCheck(
  repo: RepoCtx,
  paymentId: PaymentId,
  now = new Date(),
): Promise<{ context: EvidenceContext; check: EvidenceCheck; dto: EvidenceCheckDto } | null> {
  const context = await loadEvidenceContext(repo, paymentId);
  if (!context) return null;
  const check = checkEvidence(context.input);
  const sent = await isSent(repo, context.payment);
  return { context, check, dto: checkDto(context, check, sent, now) };
}

// ---------------------------------------------------------------------------------------------
// The send guard

function refusal(dto: EvidenceCheckDto): HttpProblem {
  const label = dto.flag === "missing" ? t.evidence.strength.missing : t.evidence.strength.weak;
  return new HttpProblem(
    "PRECONDITION_FAILED",
    `${label}. Nothing was sent. Read the reasons and acknowledge them to send this payment anyway.`,
    { details: { reason: "evidence_ack_required", check: dto } },
  );
}

function changed(dto: EvidenceCheckDto): HttpProblem {
  return new HttpProblem(
    "CONFLICT",
    "The evidence changed since you looked. Nothing was sent. Read the new reasons and try again.",
    { details: { reason: "evidence_changed", check: dto } },
  );
}

/** The refusal a check calls for given the acknowledgement (none when it is Strong or properly acknowledged). */
export function ackProblem(
  check: EvidenceCheck,
  dto: EvidenceCheckDto,
  ack: EvidenceAck | undefined,
): HttpProblem | null {
  if (check.flag === "strong") return null;
  if (!ack) return refusal(dto);
  if (ack.check_hash !== undefined && ack.check_hash !== check.check_hash) return changed(dto);
  return null;
}

/**
 * Create-and-send has no documents yet, so its evidence is always Missing: without an acknowledgement
 * it is refused before anything else (the balance included) is looked at.
 */
export function createSendProblem(
  amount: Money,
  payeeName: string,
  ack: EvidenceAck | undefined,
  policy: EvidencePolicy = parseEvidencePolicy({}),
): HttpProblem | null {
  if (ack) return null;
  const check = checkEvidence({
    payment: { amountMinor: amount.minor, currency: amount.currency, payeeName, reference: "" },
    documents: [],
    priorPayments: 0,
    policy,
  });
  const threshold = contractThreshold(policy, amount.currency);
  return refusal({
    payment: {
      id: "",
      reference: "",
      amount: toMoneyWire(amount),
      counterparty_name: payeeName,
      method: "LOCAL",
      account_fingerprint: null,
      sent: false,
    },
    flag: check.flag,
    reasons: check.reasons.map(reasonDto),
    rules: [],
    check_hash: check.check_hash,
    fact_version_ids: [],
    contract_required: check.reasons.some((r) => r.key === "contractMissing"),
    contract_threshold: toMoneyWire({ minor: threshold, currency: amount.currency }),
    documents: [],
    server_time: new Date().toISOString(),
  });
}

export interface SendOutcome {
  readonly attempt: ExecutionAttempt;
  /** The payment already had its transfer attempt: nothing was written and no acknowledgement needed. */
  readonly alreadySent: boolean;
  readonly flag: EvidenceCheck["flag"] | null;
  readonly checkHash: string | null;
  readonly overridden: boolean;
}

/**
 * Inside `tx`: runs the check, applies the acknowledgement rule, stores the snapshot (and the
 * `evidence_override` audit entry), then writes the INTENT attempt and the `transfer.create` job.
 * Throws an HttpProblem (rolling the transaction back) when the payment may not be sent.
 */
export async function sendWithGuard(
  rc: RepoCtx,
  paymentId: PaymentId,
  ack: EvidenceAck | undefined,
  actor: { readonly userId: string },
): Promise<SendOutcome> {
  const locked = await getPaymentForUpdate(rc, paymentId);
  if (!locked) throw notFound();
  const existing = (await listAttemptsForRefs(rc, "transfer", [paymentId])).at(-1);
  if (existing) {
    return { attempt: existing, alreadySent: true, flag: null, checkHash: null, overridden: false };
  }
  const loaded = await loadEvidenceCheck(rc, paymentId);
  if (!loaded) throw notFound();
  const { check, dto } = loaded;
  const problem = ackProblem(check, dto, ack);
  if (problem) throw problem;
  // Kill switch (M4-02): no new attempt while execution is paused. The payment stays as it is.
  if (!(await isExecutionEnabled(rc.db))) {
    throw new HttpProblem(
      "SERVICE_UNAVAILABLE",
      "Execution is paused, so this payment cannot be sent right now.",
    );
  }
  const override = check.flag !== "strong";
  await insertEvidenceCheck(rc, paymentId, check, "send");
  if (override) {
    await appendAudit(rc, {
      actorType: "user",
      actorId: actor.userId,
      action: EVIDENCE_AUDIT_ACTIONS.override,
      subject: `payment:${paymentId}`,
      data: {
        payment_id: paymentId,
        flag: check.flag,
        check_hash: check.check_hash,
        bound_to_check: ack?.check_hash !== undefined,
        // The reasons the owner was shown: the keys and parameters, and the sentences.
        reasons: dto.reasons,
        rules: check.rules.map((r) => ({ rule: r.rule, outcome: r.outcome })),
        fact_version_ids: check.fact_version_ids,
      },
    });
  }
  const attempt = await createAttempt(rc, {
    kind: "transfer",
    refId: paymentId,
    requestId: newRequestId(),
  });
  await enqueueJob(rc.db, {
    kind: JOB_KIND.transferCreate,
    payload: { attemptId: attempt.id, businessId: rc.businessId, paymentId },
  });
  return {
    attempt,
    alreadySent: false,
    flag: check.flag,
    checkHash: check.check_hash,
    overridden: override,
  };
}

// ---------------------------------------------------------------------------------------------
// Route specs

const IdParams = z.strictObject({ id: PaymentIdSchema });
const LinkParams = z.strictObject({ id: PaymentIdSchema, linkId: z.uuid() });
const noStore = { "cache-control": "no-store" } as const;

function spec<
  A extends AuthRule,
  B extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  P extends z.ZodType | undefined = undefined,
>(s: RouteSpec<A, B, Q, P>): RouteSpec<A, B, Q, P> {
  return s;
}

export function evidenceRouteSpecs(deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());

  const check = spec({
    method: "GET",
    auth: "session",
    params: IdParams,
    handler: async ({ repo, params }) => {
      const loaded = await loadEvidenceCheck(repo, params.id, now());
      if (!loaded) throw notFound();
      return Response.json(loaded.dto, { headers: noStore });
    },
  });

  const attach = spec({
    method: "POST",
    auth: { roles: ["owner"] },
    params: IdParams,
    body: AttachEvidenceBodySchema,
    maxBodyBytes: 1024,
    handler: async ({ ctx, repo, params, body }) => {
      const { status, dto } = await withTransaction(repo.db, async (tx) => {
        const rc = repoCtx(tx, repo.businessId);
        const attached = await attachEvidenceLink(rc, {
          paymentId: params.id,
          documentId: body.document_id,
          createdBy: ctx.userId,
        });
        if (attached.status === "not_found") throw notFound();
        const loaded = await loadEvidenceCheck(rc, params.id, now());
        if (!loaded) throw notFound();
        if (attached.status === "created") {
          await insertEvidenceCheck(rc, params.id, loaded.check, "link_added");
        }
        return { status: attached.status === "created" ? 201 : 200, dto: loaded.dto };
      });
      return Response.json(dto, { status, headers: noStore });
    },
  });

  const detach = spec({
    method: "DELETE",
    auth: { roles: ["owner"] },
    params: LinkParams,
    handler: async ({ repo, params }) => {
      const dto = await withTransaction(repo.db, async (tx) => {
        const rc = repoCtx(tx, repo.businessId);
        if (!(await removeEvidenceLink(rc, params.id, params.linkId))) throw notFound();
        const loaded = await loadEvidenceCheck(rc, params.id, now());
        if (!loaded) throw notFound();
        await insertEvidenceCheck(rc, params.id, loaded.check, "link_removed");
        return loaded.dto;
      });
      return Response.json(dto, { headers: noStore });
    },
  });

  return { check, attach, detach };
}
