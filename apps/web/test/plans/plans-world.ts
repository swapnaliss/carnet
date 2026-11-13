// Test support (M3-04): a business with the payroll-Friday plan pair stored over real rows (obligations, a
// payment to a counterparty whose beneficiary Airwallex "returns" through the recorded-response client),
// and the plan route specs wired to that client. No network: the client replays fixtures/airwallex.
import {
  createCounterparty,
  createObligation,
  createPayment,
  currentPayoutSubject,
  type Db,
  type ExecutionGateway,
  insertPlanRevision,
  repoCtx,
} from "@carnet/db";
import {
  type BusinessId,
  type CounterpartyId,
  newPaymentId,
  nextRevision,
  type PaymentId,
  type Plan,
  type PlanInputsInput,
  parseInputs,
} from "@carnet/domain";
import { replayGateway } from "../../../../packages/db/test/replay-gateway";
import { payrollFriday, withoutHold } from "../../../../packages/domain/test/planner-support";
import { type PlanDeps, planRouteSpecs } from "../../src/server/plans";

export interface PlanWorld {
  readonly businessId: BusinessId;
  readonly paymentId: string;
  readonly obligationIds: { payroll: string; supplier: string; bill: string };
  readonly inputs: PlanInputsInput;
  revision1: Plan;
  revision2: Plan;
  readonly deps: PlanDeps;
  /** Stores another revision (changed inputs) and returns it. */
  storeNext(previous: Plan, change: (i: PlanInputsInput) => PlanInputsInput): Promise<Plan>;
}

export async function seedPlanWorld(db: Db, businessId: BusinessId): Promise<PlanWorld> {
  const rc = repoCtx(db, businessId);
  const cp = await createCounterparty(rc, {
    name: "Nordlicht Print GmbH",
    country: "DE",
    beneficiaryId: "bc0bfa01-7b09-45e3-9f2a-a3cc09eb54be",
  });
  const payment = await createPayment(rc, {
    id: newPaymentId(),
    counterpartyId: cp.id as CounterpartyId,
    amount: { minor: 250000n, currency: "EUR" },
    sourceCurrency: "EUR",
    method: "SWIFT",
    reference: "INV-NORDLICHT-77",
  });
  const mk = (amount: bigint, due: string, paymentId: string | null) =>
    createObligation(rc, {
      counterpartyId: cp.id,
      amountMinor: amount,
      currency: "EUR",
      dueAt: new Date(due),
      paymentId,
      sourceDocumentId: null,
    });
  const payroll = await mk(400000n, "2026-11-06T09:00:00.000Z", null);
  const supplier = await mk(250000n, "2026-11-06T09:00:00.000Z", payment.id);
  const bill = await mk(250000n, "2026-11-06T09:00:00.000Z", null);

  const base = payrollFriday();
  const swap = (v: string) =>
    v === "ob-payroll"
      ? payroll.id
      : v === "ob-supplier"
        ? supplier.id
        : v === "ob-bill"
          ? bill.id
          : v === "pay-supplier"
            ? payment.id
            : v;
  const retag = (i: PlanInputsInput): PlanInputsInput => ({
    ...i,
    businessId,
    balances: i.balances?.map((b) => ({ ...b, businessId })),
    held: i.held?.map((h) => ({ ...h, businessId, paymentId: swap(h.paymentId) })),
    reserveFloor: i.reserveFloor?.map((f) => ({ ...f, businessId })),
    obligations: i.obligations?.map((o) => ({
      ...o,
      businessId,
      id: swap(o.id),
      paymentId: o.paymentId === null ? null : swap(o.paymentId),
      criticality: o.id === "ob-payroll" ? "UNCONFIRMED" : o.criticality,
    })),
  });
  const inputs = retag(base);
  const calm = retag(withoutHold(base));

  const first = nextRevision(null, calm);
  await insertPlanRevision(rc, first, { inputs: parseInputs(calm), trigger: "seed" });
  const second = nextRevision(first, inputs);
  await insertPlanRevision(rc, second, { inputs: parseInputs(inputs), trigger: "seed" });

  const replay = replayGateway();
  const payoutSubject: NonNullable<PlanDeps["payoutSubject"]> = async (c, paymentId, who) => {
    const live = await currentPayoutSubject(
      { db: c.db, gateway: replay.client as unknown as ExecutionGateway },
      c.businessId,
      paymentId,
      who,
    );
    return typeof live === "string" ? live : live.subject;
  };
  const deps: PlanDeps = { payoutSubject, executionEnabled: async () => true };
  const world: PlanWorld = {
    businessId,
    paymentId: payment.id as PaymentId,
    obligationIds: { payroll: payroll.id, supplier: supplier.id, bill: bill.id },
    inputs,
    revision1: first,
    revision2: second,
    deps,
    async storeNext(previous, change) {
      const changed = change(inputs);
      const next = nextRevision(previous, changed);
      await insertPlanRevision(rc, next, { inputs: parseInputs(changed), trigger: "test" });
      return next;
    },
  };
  return world;
}

export const specsFor = (world: PlanWorld) => planRouteSpecs(world.deps);
