import { notFound } from "next/navigation";
import { PlanScreen } from "@/components/plan/plan-screen";
import { PageTitle } from "@/components/shell/empty-state";
import type { ActionDto, PlanView } from "@/server/plans";
import { t } from "@/strings";

export const dynamic = "force-dynamic";

const HASH = "9f2c1ab07d3e4c55a1b8f0e6d7c2a914b3e5f60718293a4b5c6d7e8f9012a3b4";
const base = {
  reason_facts: { spendable_before_minor: "420000", covered_by_conversion_minor: "0" },
  needs_approval: false,
  state_reason: null,
  approvable: false,
  bound: null,
  bound_unavailable: false,
  auto: null,
  approved_at: null,
} as const;

const convert = (id: string, seq: number, over: Partial<ActionDto>): ActionDto =>
  ({
    ...base,
    id,
    seq,
    kind: "convert",
    reason_code: "CONVERT_SHORTFALL",
    reason_facts: { fx_spread_bps: 50, swift_fee_included_minor: "1341" },
    params: {
      sell_currency: "USD",
      buy_currency: "EUR",
      sell_minor: "789012",
      buy_minor: "720000",
      swift_fee_included_minor: "1341",
      rate: "0.91253",
      rate_low: "0.9080",
      rate_high: "0.9171",
      rate_as_of: "2026-11-04T09:00:00.000Z",
      auto_eligible: true,
      obligation_ids: ["o1"],
    },
    state: "DONE",
    ...over,
  }) as ActionDto;

/**
 * Renders the plan screen's remaining states for the design review: an automatic conversion within
 * policy (limit remaining), an executing one, a failed one, an approvable payout with its bound details,
 * and a deferral. Fabricated view data, labelled as such by its route: it exists only to be looked at.
 * Off unless the server runs with CARNET_ERROR_PREVIEW=1 (set only by playwright.config.ts); otherwise a
 * plain 404. `?unreachable=1` shows the Airwallex-unreachable banner with the payout approval paused.
 */
export default async function PlanStatesPreview({
  searchParams,
}: {
  searchParams: Promise<{ unreachable?: string; stale?: string }>;
}) {
  if (process.env.CARNET_ERROR_PREVIEW !== "1") notFound();
  const query = await searchParams;
  const unreachable = query.unreachable === "1";
  const payout = {
    ...base,
    id: "a-payout",
    seq: 4,
    kind: "payout",
    reason_code: "PAYOUT_ALTERNATE_FOR_HELD",
    needs_approval: true,
    params: {
      obligation_id: "o2",
      payee: "Rheinblick Druck GmbH",
      currency: "EUR",
      amount_minor: "720000",
      criticality: "2",
      held_payment_id: "p1",
      fee_minor: "1341",
      reserved_minor: "721341",
      criticality_unconfirmed: false,
    },
    state: "PROPOSED",
    approvable: true,
    bound: unreachable
      ? null
      : {
          source_account: "acct_8Kd2Lq0Fexample",
          source_currency: "EUR",
          beneficiary_fingerprint: HASH,
          amount_minor: "720000",
          currency: "EUR",
          fee_option: "DEFAULT",
          value_date: "2026-11-10",
          reference: "INV-2026-1187",
          counterparty_id: "cp-rheinblick",
        },
    bound_unavailable: unreachable,
  } as unknown as ActionDto;
  const actions: ActionDto[] = [
    convert("a-done", 1, {
      auto: {
        policy_version: 3,
        policy_hash: HASH,
        currency: "USD",
        amount_minor: "789012",
        cap_minor: "1000000",
        remaining_minor: "210988",
      },
    }),
    convert("a-exec", 2, { state: "EXECUTING", auto: null }),
    convert("a-fail", 3, {
      state: "FAILED",
      state_reason: "the quote was rejected by Airwallex",
    }),
    payout,
    {
      ...base,
      id: "a-defer",
      seq: 5,
      kind: "defer",
      reason_code: "DEFER_SHORT_OF_CASH",
      reason_facts: { spendable_minor: "120000", needed_minor: "250000", grace_days: 7 },
      needs_approval: true,
      params: {
        obligation_id: "o3",
        payee: "Hosting bill",
        currency: "EUR",
        amount_minor: "250000",
        criticality: "2",
        current_due_at: "2026-11-06T09:00:00.000Z",
        proposed_due_at: "2026-11-13T09:00:00.000Z",
      },
      state: "PROPOSED",
    } as unknown as ActionDto,
  ];
  const obligation = (
    id: string,
    payee: string,
    fate: "funded" | "alternate_payout" | "deferred",
  ) => ({
    id,
    payee,
    currency: "EUR",
    amount_minor: "720000",
    due_at: "2026-11-06T09:00:00.000Z",
    fate,
    proposed_due_at: fate === "deferred" ? "2026-11-13T09:00:00.000Z" : null,
    previous_fate: "funded" as const,
    changed: fate !== "funded",
    criticality: null,
  });
  const balance = (currency: string, a: string, h: string, f: string, p: string) => ({
    currency,
    available_minor: a,
    held_minor: h,
    reserve_floor_minor: f,
    projected_minor: p,
  });
  const view: PlanView = {
    generated_at: "2026-11-04T09:00:00.000Z",
    role: "owner",
    can_act: true,
    latest_revision: 4,
    airwallex_unreachable: unreachable,
    plan: {
      revision: 4,
      previous_revision: 3,
      is_latest: true,
      inputs_hash: HASH,
      content_hash: HASH,
      planned_at: "2026-11-04T09:00:00.000Z",
      created_at: "2026-11-04T09:00:01.000Z",
      policy_version: 3,
      policy_hash: HASH,
      trigger: { kind: "held", payee: "Rheinblick Druck GmbH" },
      balances: [
        balance("EUR", "500000", "250000", "50000", "120000"),
        balance("USD", "800000", "0", "100000", "10988"),
      ],
      previous_balances: [
        balance("EUR", "500000", "0", "50000", "220000"),
        balance("USD", "800000", "0", "100000", "10988"),
      ],
      obligations: [
        obligation("o1", "Payroll (team)", "funded"),
        obligation("o2", "Rheinblick Druck GmbH", "alternate_payout"),
        obligation("o3", "Hosting bill", "deferred"),
      ],
      actions,
      explanation: null,
    },
  };
  return (
    <>
      <PageTitle>{t.plan.title}</PageTitle>
      <PlanScreen initial={view} staticPreview previewStale={query.stale === "1"} />
    </>
  );
}
