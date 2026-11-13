// The plan read model and the bound plan-action approval (M3-04, ADR 0008, 0011).
//
//   GET  /api/v1/plans/current              any session → PlanView of the newest revision (plan null before the first)
//   GET  /api/v1/plans/{revision}           any session → PlanView of that revision; 404 when it does not exist
//   POST /api/v1/plan-actions/{id}/approve  owner, approver → 201 { approval }
//
// The view is assembled from the stored revision pair: balances, holds and floors from each revision's
// stored inputs, the fate of every obligation from its actions, each action's execution state
// (plan_action_states), the auto-approval record and the owner's approval where there is one.
//
// Approving binds the owner to exactly the content the page rendered. The body carries the plan
// revision and the `shown` fields; the server rebuilds the subject from its own rows (a conversion from
// the stored action, a payout from the payment, the counterparty and the beneficiary as Airwallex
// returns it now), refuses with 409 when the revision is no longer the newest or any shown field
// differs from what it derived, then hashes the subject, stores the hash and the shown snapshot, moves
// the action PROPOSED to APPROVED and queues the executor, in one transaction. It never sends money in
// the request (the worker does, after consuming the approval, M3-03).
import { createHash } from "node:crypto";
import {
  type Approval,
  appendAudit,
  autoApprovedTotalToday,
  buildConversionSubject,
  createApproval,
  currentPayoutSubject,
  DuplicateIdempotencyKeyError,
  type ExecutionGateway,
  enqueueJob,
  getAutoApprovalForAction,
  getIdempotencyRecord,
  getLatestCriticalityProposal,
  getLatestPlan,
  getLatestPolicy,
  getPlanByRevision,
  getStoredAction,
  getSystemFlags,
  getUser,
  type IdempotencyRecord,
  latestPlanId,
  listApprovalsForSubject,
  listObligations,
  listStoredActions,
  type Obligation,
  type RepoCtx,
  repoCtx,
  type StoredAction,
  type StoredPlan,
  saveIdempotencyRecord,
  transitionAction,
  withTransaction,
} from "@carnet/db";
import {
  type AnySubject,
  approvalCanonicalJson,
  approvalHash,
  type ConversionSubject,
  type CriticalityProposalView,
  type Currency,
  IdempotencyKeySchema,
  type PayoutSubject,
  type Plan,
  type PlanAction,
  type PlanInputs,
  type PlanInputsInput,
  parseInputs,
  planningCriticality,
  renderExplanation,
  type UserId,
  verifyExplanation,
} from "@carnet/domain";
import { z } from "zod";
import type { AuthRule, RouteSpec } from "../lib/define-route";
import { conflict, HttpProblem, notFound } from "../lib/errors";
import { webAirwallex } from "./airwallex";
import { approvalTtlMinutes } from "./approvals";
import { toProposalView } from "./obligation-routes";

type Schema = z.ZodType | undefined;
const routeSpec = <A extends AuthRule, B extends Schema, Q extends Schema, P extends Schema>(
  spec: RouteSpec<A, B, Q, P>,
) => spec;

const NO_STORE = { "cache-control": "private, no-store" } as const;

// ---- view model ------------------------------------------------------------------------------

export type Fate = "funded" | "alternate_payout" | "deferred" | "escalated";

type ActionState = StoredAction["state"];

export interface BalanceRowDto {
  readonly currency: string;
  readonly available_minor: string;
  /** Funds a held transfer ties up: shown as unavailable. */
  readonly held_minor: string;
  readonly reserve_floor_minor: string;
  /** What the account holds after every funding step of the plan has run. */
  readonly projected_minor: string;
}

export interface ObligationRowDto {
  readonly id: string;
  readonly payee: string;
  readonly currency: string;
  readonly amount_minor: string;
  readonly due_at: string;
  readonly fate: Fate;
  readonly proposed_due_at: string | null;
  readonly previous_fate: Fate | null;
  readonly changed: boolean;
  /** Null when the obligation is not a stored row (a replayed plan). */
  readonly criticality: {
    readonly planning: "1" | "2" | "3" | "UNCONFIRMED";
    readonly confirmed_by_name: string | null;
    readonly confirmed_at: string | null;
    readonly proposal: CriticalityProposalView | null;
  } | null;
}

export interface AutoDto {
  readonly policy_version: number;
  readonly policy_hash: string;
  readonly currency: string;
  readonly amount_minor: string;
  readonly cap_minor: string | null;
  readonly remaining_minor: string | null;
}

export interface ActionDto {
  readonly id: string;
  readonly seq: number;
  readonly kind: PlanAction["kind"];
  readonly reason_code: string;
  readonly reason_facts: PlanAction["reason_facts"];
  readonly params: PlanAction["params"];
  readonly needs_approval: boolean;
  readonly state: ActionState;
  readonly state_reason: string | null;
  /** True when the page may show the approve control (kind, state and revision allow it). */
  readonly approvable: boolean;
  /** The exact fields an approval is bound to, as strings; null when they cannot be shown now. */
  readonly bound: Record<string, string> | null;
  readonly bound_unavailable: boolean;
  readonly auto: AutoDto | null;
  readonly approved_at: string | null;
}

export type TriggerDto =
  | { readonly kind: "first" }
  | { readonly kind: "held"; readonly payee: string | null }
  | { readonly kind: "inputs_changed" };

export interface PlanBlockDto {
  readonly revision: number;
  readonly previous_revision: number | null;
  readonly is_latest: boolean;
  readonly inputs_hash: string;
  readonly content_hash: string;
  readonly planned_at: string;
  readonly created_at: string;
  readonly policy_version: number;
  readonly policy_hash: string;
  readonly trigger: TriggerDto;
  readonly balances: BalanceRowDto[];
  readonly previous_balances: BalanceRowDto[] | null;
  readonly obligations: ObligationRowDto[];
  readonly actions: ActionDto[];
  /** Null when the template text did not verify against the plan: the screen shows raw reasons. */
  readonly explanation: string | null;
}

export interface PlanView {
  readonly generated_at: string;
  readonly role: string;
  readonly can_act: boolean;
  readonly latest_revision: number | null;
  /** True when the payout details could not be read from Airwallex (the banner says so). */
  readonly airwallex_unreachable: boolean;
  readonly plan: PlanBlockDto | null;
}

export interface PlanDeps {
  readonly now?: () => Date;
  readonly ttlMinutes?: number;
  readonly executionEnabled?: (rc: RepoCtx) => Promise<boolean>;
  /** The payout subject from live state; defaults to the web process's Airwallex client. */
  readonly payoutSubject?: (
    rc: RepoCtx,
    paymentId: string,
    who: { approverId: UserId; nonce: string },
  ) => Promise<PayoutSubject | string>;
  /** Replaces the explanation renderer (a test hands in a tampered text to see the fallback). */
  readonly renderExplanation?: (plan: Plan) => string;
}

/** The payout subject as the live state says it is, through the real client (one read, short timeout). */
export const liveGatewayPayoutSubject: NonNullable<PlanDeps["payoutSubject"]> = async (
  rc,
  paymentId,
  who,
) => {
  const gateway = webAirwallex() as unknown as ExecutionGateway;
  const live = await currentPayoutSubject({ db: rc.db, gateway }, rc.businessId, paymentId, who);
  return typeof live === "string" ? live : live.subject;
};

const NOBODY = { approverId: "00000000-0000-0000-0000-000000000000" as UserId, nonce: "view" };

/** The fields an approval of a conversion is bound to, in the order the page shows them. */
export function conversionShown(s: ConversionSubject): Record<string, string> {
  return {
    sell_currency: s.sellCurrency,
    buy_currency: s.buyCurrency,
    sell_minor: s.sellMinor,
    rate_low: s.rateLow,
    rate_high: s.rateHigh,
  };
}

/** The fields an approval of a payout is bound to (ADR 0008). */
export function payoutShown(s: PayoutSubject): Record<string, string> {
  return {
    source_account: s.sourceAccount,
    source_currency: s.sourceCurrency,
    beneficiary_fingerprint: s.beneficiaryFingerprint,
    amount_minor: s.amountMinor,
    currency: s.currency,
    fee_option: s.feeOption,
    value_date: s.valueDate,
    reference: s.reference,
    counterparty_id: s.counterpartyId,
  };
}

const sum = (xs: Iterable<bigint>): bigint => {
  let t = 0n;
  for (const x of xs) t += x;
  return t;
};

function readInputs(stored: StoredPlan): PlanInputs | null {
  try {
    return parseInputs(stored.inputs as PlanInputsInput);
  } catch {
    return null;
  }
}

/** Per-currency balances from a revision's stored inputs and its actions. */
export function balanceRows(plan: Plan, inputs: PlanInputs | null): BalanceRowDto[] {
  if (!inputs) return [];
  const visible = inputs.config.heldFundsVisibleInBalances;
  const currencies = new Set<string>([
    ...inputs.balances.map((b) => b.currency),
    ...inputs.held.map((h) => h.currency),
    ...inputs.reserveFloor.map((f) => f.currency),
  ]);
  return [...currencies].sort().map((currency) => {
    const available = sum(
      inputs.balances.filter((b) => b.currency === currency).map((b) => b.availableMinor),
    );
    const held = sum(inputs.held.filter((h) => h.currency === currency).map((h) => h.amountMinor));
    const floor = sum(
      inputs.reserveFloor.filter((f) => f.currency === currency).map((f) => f.minor),
    );
    let projected = available - (visible ? 0n : held);
    for (const a of plan.actions) {
      if (a.kind === "convert") {
        if (a.params.buy_currency === currency) projected += BigInt(a.params.buy_minor);
        if (a.params.sell_currency === currency) projected -= BigInt(a.params.sell_minor);
      } else if ((a.kind === "fund" || a.kind === "payout") && a.params.currency === currency) {
        projected -= BigInt(a.params.reserved_minor);
      }
    }
    return {
      currency,
      available_minor: available.toString(),
      held_minor: held.toString(),
      reserve_floor_minor: floor.toString(),
      projected_minor: projected.toString(),
    };
  });
}

const FATE_OF: Record<string, Fate | undefined> = {
  fund: "funded",
  payout: "alternate_payout",
  defer: "deferred",
  escalate: "escalated",
};

function fateOf(plan: Plan, obligationId: string): { fate: Fate; proposed: string | null } | null {
  for (const a of plan.actions) {
    if (a.kind === "convert") continue;
    if (a.params.obligation_id !== obligationId) continue;
    const fate = FATE_OF[a.kind];
    if (!fate) continue;
    return { fate, proposed: a.kind === "defer" ? a.params.proposed_due_at : null };
  }
  return null;
}

function triggerOf(
  current: Plan,
  inputs: PlanInputs | null,
  previous: StoredPlan | null,
  previousInputs: PlanInputs | null,
): TriggerDto {
  if (!previous) return { kind: "first" };
  if (!inputs || !previousInputs) return { kind: "inputs_changed" };
  const before = new Set(previousInputs.held.map((h) => h.paymentId));
  const fresh = inputs.held.filter((h) => !before.has(h.paymentId));
  if (fresh.length === 0) return { kind: "inputs_changed" };
  const payout = current.actions.find(
    (a) => a.kind === "payout" && fresh.some((h) => h.paymentId === a.params.held_payment_id),
  );
  const payee = payout && payout.kind === "payout" ? payout.params.payee : null;
  return { kind: "held", payee };
}

const dtoOfStored = (
  s: StoredAction,
): Pick<
  ActionDto,
  | "id"
  | "seq"
  | "kind"
  | "reason_code"
  | "reason_facts"
  | "params"
  | "needs_approval"
  | "state"
  | "state_reason"
> => ({
  id: s.id,
  seq: s.action.seq,
  kind: s.action.kind,
  reason_code: s.action.reason_code,
  reason_facts: s.action.reason_facts,
  params: s.action.params,
  needs_approval: s.action.needs_approval,
  state: s.state,
  state_reason: s.stateReason,
});

const APPROVE_ROLES = new Set(["owner", "approver"]);

export async function loadPlanView(
  rc: RepoCtx,
  who: { role: string },
  which: "current" | number,
  deps: PlanDeps = {},
): Promise<PlanView | null> {
  const now = (deps.now ?? (() => new Date()))();
  const latest = await getLatestPlan(rc);
  const generated = {
    generated_at: now.toISOString(),
    role: who.role,
    can_act: APPROVE_ROLES.has(who.role),
  };
  if (!latest) {
    if (which !== "current") return null;
    return { ...generated, latest_revision: null, airwallex_unreachable: false, plan: null };
  }
  const stored = which === "current" ? latest : await getPlanByRevision(rc, which);
  if (!stored) return null;
  const plan = stored.plan;
  const previous = plan.revision > 1 ? await getPlanByRevision(rc, plan.revision - 1) : null;
  const inputs = readInputs(stored);
  const previousInputs = previous ? readInputs(previous) : null;
  const isLatest = stored.id === latest.id;

  const storedActions = await listStoredActions(rc, stored.id);
  const policy = await getLatestPolicy(rc);
  let unreachable = false;

  const actions: ActionDto[] = [];
  for (const s of storedActions) {
    const base = dtoOfStored(s);
    const approvableKind =
      s.action.kind === "payout" || (s.action.kind === "convert" && s.action.needs_approval);
    const approvable = approvableKind && s.state === "PROPOSED" && isLatest;
    let bound: Record<string, string> | null = null;
    let boundUnavailable = false;
    if (approvable && s.action.kind === "convert") {
      const subject = buildConversionSubject(s, {
        businessId: rc.businessId,
        approverId: NOBODY.approverId,
        nonce: NOBODY.nonce,
      });
      bound = subject ? conversionShown(subject) : null;
    } else if (approvable && s.action.kind === "payout") {
      try {
        const reader = deps.payoutSubject ?? liveGatewayPayoutSubject;
        const subject = await reader(rc, s.action.params.held_payment_id, NOBODY);
        if (typeof subject === "string") boundUnavailable = true;
        else bound = payoutShown(subject);
      } catch {
        boundUnavailable = true;
        unreachable = true;
      }
    }
    let auto: AutoDto | null = null;
    if (s.action.kind === "convert") {
      const record = await getAutoApprovalForAction(rc, s.id);
      if (record) {
        const cap = policy?.dailyCap.find((c) => c.currency === record.currency)?.minor;
        const used = await autoApprovedTotalToday(rc, record.currency as Currency, now);
        const capMinor = cap === undefined ? null : BigInt(cap);
        auto = {
          policy_version: record.policyVersion,
          policy_hash: record.policyHash,
          currency: record.currency,
          amount_minor: record.amountMinor.toString(),
          cap_minor: capMinor === null ? null : capMinor.toString(),
          remaining_minor:
            capMinor === null ? null : (capMinor > used ? capMinor - used : 0n).toString(),
        };
      }
    }
    let approvedAt: string | null = null;
    if (!auto && ["APPROVED", "EXECUTING", "DONE", "FAILED"].includes(s.state)) {
      const subjectRef = s.action.kind === "payout" ? s.action.params.held_payment_id : s.id;
      const kind = s.action.kind === "payout" ? "payout" : "conversion";
      const list = await listApprovalsForSubject(rc, kind, subjectRef);
      const mine = list.find((a) => a.status !== "REJECTED" && a.status !== "EXPIRED");
      approvedAt = mine?.createdAt.toISOString() ?? null;
    }
    actions.push({
      ...base,
      approvable,
      bound,
      bound_unavailable: boundUnavailable,
      auto,
      approved_at: approvedAt,
    });
  }

  // Obligations: the plan's, with the stored row's criticality when there is one.
  const rows = new Map<string, Obligation>((await listObligations(rc, 200)).map((o) => [o.id, o]));
  const userNames = new Map<string, string | null>();
  const nameOf = async (id: string | null): Promise<string | null> => {
    if (!id) return null;
    if (!userNames.has(id)) {
      const u = await getUser(rc, id as UserId);
      userNames.set(id, u ? (u.name ?? u.email) : null);
    }
    return userNames.get(id) ?? null;
  };
  const ids: string[] = [];
  for (const a of plan.actions) {
    if (a.kind !== "convert" && !ids.includes(a.params.obligation_id))
      ids.push(a.params.obligation_id);
  }
  const obligations: ObligationRowDto[] = [];
  for (const id of ids) {
    const action = plan.actions.find((a) => a.kind !== "convert" && a.params.obligation_id === id);
    if (!action || action.kind === "convert") continue;
    const fate = fateOf(plan, id);
    if (!fate) continue;
    const before = previous ? fateOf(previous.plan, id) : null;
    const row = rows.get(id);
    const planned = inputs?.obligations.find((o) => o.id === id);
    obligations.push({
      id,
      payee: action.params.payee,
      currency: action.params.currency,
      amount_minor: action.params.amount_minor,
      due_at: planned?.dueAt ?? row?.dueAt.toISOString() ?? plan.now,
      fate: fate.fate,
      proposed_due_at: fate.proposed,
      previous_fate: before?.fate ?? null,
      changed: previous !== null && (before === null || before.fate !== fate.fate),
      criticality: row
        ? {
            planning: String(planningCriticality(row)) as "1" | "2" | "3" | "UNCONFIRMED",
            confirmed_by_name: await nameOf(row.criticalityConfirmedBy),
            confirmed_at: row.criticalityConfirmedAt?.toISOString() ?? null,
            proposal: null,
          }
        : null,
    });
  }
  // Latest proposals, one query per stored obligation in the plan.
  const withProposals: ObligationRowDto[] = [];
  for (const o of obligations) {
    if (!o.criticality) {
      withProposals.push(o);
      continue;
    }
    const proposal = await getLatestCriticalityProposal(rc, o.id);
    withProposals.push({
      ...o,
      criticality: { ...o.criticality, proposal: proposal ? toProposalView(proposal) : null },
    });
  }

  const render = deps.renderExplanation ?? renderExplanation;
  const text = render(plan);
  const explanation = verifyExplanation(text, plan).ok ? text : null;

  return {
    ...generated,
    latest_revision: latest.plan.revision,
    airwallex_unreachable: unreachable,
    plan: {
      revision: plan.revision,
      previous_revision: previous?.plan.revision ?? null,
      is_latest: isLatest,
      inputs_hash: plan.inputs_hash,
      content_hash: plan.content_hash,
      planned_at: plan.now,
      created_at: stored.createdAt.toISOString(),
      policy_version: plan.policy.version,
      policy_hash: plan.policy.hash,
      trigger: triggerOf(plan, inputs, previous, previousInputs),
      balances: balanceRows(plan, inputs),
      previous_balances: previous ? balanceRows(previous.plan, previousInputs) : null,
      obligations: withProposals,
      actions,
      explanation,
    },
  };
}

// ---- approval --------------------------------------------------------------------------------

/** The executor job kinds (worker/handlers/execute.ts); not imported, as that module reads fees.json. */
const EXECUTE_JOB_KIND = {
  payout: "payout.execute",
  conversionApproved: "conversion.execute_approved",
} as const;

export const PlanActionIdSchema = z.uuid();
export const ApprovePlanActionBodySchema = z.strictObject({
  /** The revision the page rendered. */
  plan_revision: z.number().int().min(1),
  /** The bound fields exactly as rendered; the server compares them with what it derives. */
  shown: z.record(z.string().min(1).max(64), z.string().max(500)),
});
export type ApprovePlanActionBody = z.infer<typeof ApprovePlanActionBodySchema>;

export const approveEndpoint = (actionId: string) =>
  `POST /api/v1/plan-actions/${actionId}/approve`;

const refuse = (message: string, reason: string, extra: Record<string, unknown> = {}) =>
  new HttpProblem("PRECONDITION_FAILED", message, { details: { reason, ...extra } });
const changed = (message: string, reason: "PLAN_CHANGED" | "CONTENT_CHANGED") =>
  new HttpProblem("CONFLICT", message, { details: { reason } });

export interface PlanSnapshot {
  readonly version: 1;
  /** Exactly what the hash covers. */
  readonly subject: AnySubject;
  /** The fields as rendered, with the plan revision they came from. */
  readonly shown: Record<string, string>;
  readonly planRevision: number;
  readonly planContentHash: string;
  readonly actionId: string;
}

function approvalDto(a: Approval, now: Date) {
  return {
    id: a.id,
    kind: a.kind,
    subject_ref: a.subjectRef,
    status:
      a.expiresAt.getTime() <= now.getTime() && a.status === "APPROVED" ? "EXPIRED" : a.status,
    hash: a.hash,
    approver_id: a.approverId,
    expires_at: a.expiresAt.toISOString(),
    created_at: a.createdAt.toISOString(),
    shown_snapshot: a.shownSnapshot,
  };
}

function sameFields(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

async function defaultExecutionEnabled(rc: RepoCtx): Promise<boolean> {
  try {
    return (await getSystemFlags(rc.db)).executionEnabled;
  } catch {
    return false;
  }
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

const bodyHash = (body: ApprovePlanActionBody): string =>
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
    headers: { ...NO_STORE, "idempotent-replayed": "true", "x-request-id": requestId },
  });
}

export async function approvePlanAction(
  input: {
    repo: RepoCtx;
    userId: UserId;
    actionId: string;
    body: ApprovePlanActionBody;
    key: string;
    requestId: string;
  },
  deps: PlanDeps = {},
): Promise<Response> {
  const { repo, userId, actionId, body, key, requestId } = input;
  const now = deps.now ?? (() => new Date());
  const endpoint = approveEndpoint(actionId);
  const hash = bodyHash(body);
  const existing = await getIdempotencyRecord(repo, endpoint, key);
  if (existing) return replay(existing, hash, requestId);

  const stored = await getStoredAction(repo, actionId);
  if (!stored) throw notFound();
  const action = stored.action;
  const isConversion = action.kind === "convert" && action.needs_approval;
  if (action.kind !== "payout" && !isConversion) {
    throw refuse("This action does not take an approval.", "NOT_APPROVABLE");
  }

  // The plan must be the one the page rendered, and still the newest.
  if ((await latestPlanId(repo)) !== stored.planId || body.plan_revision !== stored.revision) {
    throw changed(
      "The plan changed since you looked at it. Review the new plan, then approve.",
      "PLAN_CHANGED",
    );
  }
  if (stored.state !== "PROPOSED") {
    throw conflict(`This action is already ${stored.state}. Reload to see where it stands.`);
  }
  if (!(await (deps.executionEnabled ?? defaultExecutionEnabled)(repo))) {
    throw refuse(
      "Execution is switched off, so nothing can be approved or sent right now.",
      "KILL_SWITCH",
    );
  }

  const nonce = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const who = { approverId: userId, nonce };
  let subject: ConversionSubject | PayoutSubject;
  let shown: Record<string, string>;
  let subjectRef: string;
  if (action.kind === "payout") {
    const reader = deps.payoutSubject ?? liveGatewayPayoutSubject;
    let live: PayoutSubject | string;
    try {
      live = await reader(repo, action.params.held_payment_id, who);
    } catch {
      throw refuse(
        "Airwallex could not be reached to confirm the payout details. Try again.",
        "AIRWALLEX_UNREACHABLE",
      );
    }
    if (typeof live === "string") {
      throw refuse("The payout cannot be approved from the current payment details.", live);
    }
    subject = live;
    shown = payoutShown(live);
    subjectRef = action.params.held_payment_id;
  } else {
    const built = buildConversionSubject(stored, { businessId: repo.businessId, ...who });
    if (!built) throw refuse("This action does not take an approval.", "NOT_APPROVABLE");
    subject = built;
    shown = conversionShown(built);
    subjectRef = stored.id;
  }
  if (!sameFields(shown, body.shown)) {
    throw changed(
      "What this approval covers changed since you looked at it. Review the new details, then approve.",
      "CONTENT_CHANGED",
    );
  }

  const ttl = deps.ttlMinutes ?? approvalTtlMinutes();
  const expiresAt = new Date(now().getTime() + ttl * 60_000);
  const approvalHashHex = approvalHash(subject);
  try {
    const created = await withTransaction(repo.db, async (tx) => {
      const rc = repoCtx(tx, repo.businessId);
      const snapshot: PlanSnapshot = {
        version: 1,
        subject,
        shown,
        planRevision: stored.revision,
        planContentHash: stored.planContentHash,
        actionId: stored.id,
      };
      const approval = await createApproval(rc, {
        kind: subject.kind,
        subjectRef,
        hash: approvalHashHex,
        nonce,
        approverId: userId,
        expiresAt,
        shownSnapshot: snapshot,
      });
      // Compare-and-set: another approval, a replan or an executor may have moved the action.
      if (!(await transitionAction(rc, stored.id, ["PROPOSED"], "APPROVED"))) {
        throw changed(
          "The plan changed since you looked at it. Review the new plan, then approve.",
          "PLAN_CHANGED",
        );
      }
      await appendAudit(rc, {
        actorType: "user",
        actorId: userId,
        action: "plan_action.approved",
        subject: `plan_action:${stored.id}`,
        data: {
          approvalId: approval.id,
          hash: approvalHashHex,
          kind: subject.kind,
          planRevision: stored.revision,
          expiresAt: expiresAt.toISOString(),
        },
      });
      await enqueueJob(
        tx,
        subject.kind === "payout"
          ? {
              kind: EXECUTE_JOB_KIND.payout,
              payload: {
                businessId: repo.businessId,
                approvalId: approval.id,
                hash: approvalHashHex,
                paymentId: subjectRef,
                actionId: stored.id,
              },
            }
          : {
              kind: EXECUTE_JOB_KIND.conversionApproved,
              payload: {
                businessId: repo.businessId,
                approvalId: approval.id,
                hash: approvalHashHex,
              },
            },
      );
      const response = { approval: approvalDto(approval, now()) };
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
      headers: { ...NO_STORE, "x-request-id": requestId },
    });
  } catch (error) {
    if (error instanceof DuplicateIdempotencyKeyError) {
      const winner = await getIdempotencyRecord(repo, endpoint, key);
      if (winner) return replay(winner, hash, requestId);
    }
    throw error;
  }
}

// ---- route specs -----------------------------------------------------------------------------

const RevisionParams = z.strictObject({ revision: z.coerce.number().int().min(1).max(1_000_000) });
const ActionParams = z.strictObject({ id: PlanActionIdSchema });

export function planRouteSpecs(deps: PlanDeps = {}) {
  const current = routeSpec({
    method: "GET",
    auth: "session",
    handler: async ({ ctx, repo }) => {
      const view = await loadPlanView(repo, ctx, "current", deps);
      return Response.json(view, { headers: NO_STORE });
    },
  });
  const byRevision = routeSpec({
    method: "GET",
    auth: "session",
    params: RevisionParams,
    handler: async ({ ctx, repo, params }) => {
      const view = await loadPlanView(repo, ctx, params.revision, deps);
      if (!view) throw notFound();
      return Response.json(view, { headers: NO_STORE });
    },
  });
  const approve = routeSpec({
    method: "POST",
    auth: { roles: ["owner", "approver"] as const },
    params: ActionParams,
    body: ApprovePlanActionBodySchema,
    maxBodyBytes: 16 * 1024,
    rateLimit: { name: "approval", by: "user" },
    handler: async ({ req, ctx, repo, params, body, requestId }) =>
      approvePlanAction(
        {
          repo,
          userId: ctx.userId,
          actionId: params.id,
          body,
          key: idempotencyKeyOf(req),
          requestId,
        },
        deps,
      ),
  });
  return { current, byRevision, approve };
}
