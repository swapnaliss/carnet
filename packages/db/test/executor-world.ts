// Test support (M3-03): a business with an owner, a policy, stored plan revisions and a payable payment.
import {
  type ApprovalId,
  approvalHash,
  type BusinessId,
  type Currency,
  newPaymentId,
  type Plan,
  type PlanAction,
  sha256Hex,
  type UserId,
} from "@carnet/domain";
import type { Db } from "../src/client";
import {
  buildConversionSubject,
  currentPayoutSubject,
  type ExecutionGateway,
  type ExecutorDeps,
} from "../src/executors/index";
import { createApproval } from "../src/repos/approvals";
import { type RepoCtx, repoCtx } from "../src/repos/context";
import { createCounterparty } from "../src/repos/counterparties";
import {
  createBusiness,
  createPolicyVersion,
  createUser,
  getStoredAction,
  listStoredActions,
  transitionAction,
} from "../src/repos/index";
import { createPayment } from "../src/repos/payments";
import { insertPlanRevision } from "../src/repos/plans";
import type { ReplayClient } from "./replay-gateway";

export const POLICY = {
  reserveFloor: [{ currency: "USD" as const, minor: "10000" }],
  perActionLimit: [{ currency: "USD" as const, minor: "1000" }],
  dailyCap: [{ currency: "USD" as const, minor: "9990" }],
  slippageBps: 100,
  quoteFreshnessSeconds: 300,
};

export interface World {
  readonly db: Db;
  readonly businessId: BusinessId;
  readonly userId: UserId;
  readonly ctx: RepoCtx;
}

export async function seedWorld(
  db: Db,
  options: { timezone?: string; airwallexAccountId?: string; policy?: typeof POLICY | null } = {},
): Promise<World> {
  const businessId = await createBusiness(db, {
    name: `Exec Co ${crypto.randomUUID().slice(0, 8)}`,
    ...(options.timezone ? { timezone: options.timezone } : {}),
    airwallexAccountId: options.airwallexAccountId ?? `acct_${crypto.randomUUID().slice(0, 8)}`,
  });
  const ctx = repoCtx(db, businessId);
  const user = await createUser(ctx, {
    email: `owner-${crypto.randomUUID().slice(0, 8)}@exec.test`,
    role: "owner",
  });
  if (options.policy !== null) await createPolicyVersion(ctx, options.policy ?? POLICY);
  return { db, businessId, userId: user.id, ctx };
}

export function convertAction(seq: number, over: Record<string, unknown> = {}): PlanAction {
  return {
    seq,
    kind: "convert",
    reason_code: "CONVERT_SHORTFALL",
    reason_facts: { sell_currency: "USD", buy_currency: "EUR" },
    needs_approval: false,
    params: {
      sell_currency: "USD",
      buy_currency: "EUR",
      sell_minor: "999",
      buy_minor: "883",
      swift_fee_included_minor: "0",
      rate: "0.8840",
      rate_low: "0.8796",
      rate_high: "0.8884",
      rate_as_of: "2026-11-11T09:00:00.000Z",
      auto_eligible: true,
      obligation_ids: ["o-1"],
      ...over,
    },
  } as PlanAction;
}

/** Stores a plan revision with these actions; returns the plan id and the action ids in order. */
export async function storePlan(
  world: World,
  actions: PlanAction[],
  revision = 1,
): Promise<{ planId: string; actionIds: string[]; plan: Plan }> {
  const seed = `${world.businessId}:${revision}:${Math.random()}`;
  const plan: Plan = {
    schema_version: 1,
    business_id: world.businessId,
    revision,
    inputs_hash: sha256Hex(`inputs:${seed}`),
    content_hash: sha256Hex(`content:${seed}`),
    now: "2026-11-11T09:00:00.000Z",
    policy: { version: 1, hash: sha256Hex("policy") },
    held_funds_visible_in_balances: true,
    actions,
  };
  const { stored } = await insertPlanRevision(world.ctx, plan, { inputs: { seed } });
  const rows = await listStoredActions(world.ctx, stored.id);
  return { planId: stored.id, actionIds: rows.map((r) => r.id), plan };
}

export function depsOf(
  world: World,
  client: ReplayClient,
  extra: Partial<ExecutorDeps> = {},
): ExecutorDeps {
  return {
    db: world.db,
    gateway: client as unknown as ExecutionGateway,
    swiftPayoutFeeMinor: (c: Currency) => (c === "EUR" ? 1341n : 0n),
    ...extra,
  };
}

/** Approves a conversion action as the owner would: a bound approval for exactly what is stored. */
export async function approveConversion(
  world: World,
  actionId: string,
  over: { ttlMs?: number } = {},
): Promise<{ approvalId: ApprovalId; expectedHash: string }> {
  const stored = await getStoredAction(world.ctx, actionId);
  if (!stored) throw new Error("no action");
  const nonce = crypto.randomUUID();
  const subject = buildConversionSubject(stored, {
    businessId: world.businessId,
    approverId: world.userId,
    nonce,
  });
  if (!subject) throw new Error("not a conversion");
  const hash = approvalHash(subject);
  const a = await createApproval(world.ctx, {
    kind: "conversion",
    subjectRef: actionId,
    hash,
    nonce,
    approverId: world.userId,
    expiresAt: new Date(Date.now() + (over.ttlMs ?? 30 * 60_000)),
    shownSnapshot: subject,
  });
  await transitionAction(world.ctx, actionId, ["PROPOSED"], "APPROVED");
  return { approvalId: a.id, expectedHash: hash };
}

export interface PayoutFixture {
  readonly paymentId: string;
  readonly counterpartyId: string;
}

/** A USD LOCAL payment to a counterparty whose beneficiary exists at Airwallex. */
export async function seedPayment(
  world: World,
  over: { amountMinor?: bigint; reference?: string } = {},
): Promise<PayoutFixture> {
  const cp = await createCounterparty(world.ctx, {
    name: "Northwind Test Supplies LLC",
    country: "US",
    beneficiaryId: "bc0bfa01-7b09-45e3-9f2a-a3cc09eb54be",
  });
  const payment = await createPayment(world.ctx, {
    id: newPaymentId(),
    counterpartyId: cp.id,
    amount: { minor: over.amountMinor ?? 2500n, currency: "USD" },
    sourceCurrency: "USD",
    method: "LOCAL",
    reference: over.reference ?? "INV-2026-1001",
  });
  return { paymentId: payment.id, counterpartyId: cp.id };
}

/** An approval of the payout exactly as the live state shows it now. */
export async function approvePayout(
  world: World,
  client: ReplayClient,
  paymentId: string,
): Promise<{ approvalId: ApprovalId; expectedHash: string }> {
  const nonce = crypto.randomUUID();
  const live = await currentPayoutSubject(
    { db: world.db, gateway: client as unknown as ExecutionGateway },
    world.businessId,
    paymentId,
    { approverId: world.userId, nonce },
  );
  if (typeof live === "string") throw new Error(live);
  const hash = approvalHash(live.subject);
  const a = await createApproval(world.ctx, {
    kind: "payout",
    subjectRef: paymentId,
    hash,
    nonce,
    approverId: world.userId,
    expiresAt: new Date(Date.now() + 30 * 60_000),
    shownSnapshot: live.subject,
  });
  return { approvalId: a.id, expectedHash: hash };
}
