"use client";

import { ArrowRight, CircleCheck, Lock, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { StatusBadge } from "@/components/payments/status-badge";
import { Button } from "@/components/ui/button";
import type { ActionDto, BalanceRowDto, ObligationRowDto, PlanBlockDto } from "@/server/plans";
import { fill, t } from "@/strings";
import { CriticalityControl } from "./criticality-control";
import {
  actionStatus,
  day,
  fateLabel,
  money,
  reasonText,
  shortHash,
  signedMoney,
  when,
} from "./format";

export function Card({
  title,
  headingId,
  children,
  testId,
}: {
  title: string;
  headingId: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-4 md:p-6"
    >
      <h2 id={headingId} className="text-lg leading-tight font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

// ---- headline --------------------------------------------------------------------------------

const SEP = " \u00b7 ";

export function Headline({ plan }: { plan: PlanBlockDto }) {
  const trigger =
    plan.trigger.kind === "held"
      ? plan.trigger.payee
        ? fill(t.plan.headline.heldTrigger, { payee: plan.trigger.payee })
        : t.plan.headline.heldTriggerUnknown
      : plan.trigger.kind === "first"
        ? t.plan.headline.firstTrigger
        : t.plan.headline.changedTrigger;
  const count = (fate: string) => plan.obligations.filter((o) => o.fate === fate).length;
  const parts = [
    ["funded", count("funded")],
    ["alternate_payout", count("alternate_payout")],
    ["deferred", count("deferred")],
    ["escalated", count("escalated")],
  ] as const;
  const summary = parts
    .filter(([, n]) => n > 0)
    .map(([fate, n]) => fill(t.plan.headline.count[fate], { count: n }))
    .join(" · ");
  const waiting = plan.actions.filter((a) => a.approvable).length;
  const notFunded = count("deferred") + count("escalated");
  return (
    <section
      aria-labelledby="plan-headline"
      data-testid="plan-headline"
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-4 md:p-6"
    >
      <h2 id="plan-headline" className="text-xl leading-tight font-semibold">
        <span data-testid="plan-revision">
          {fill(t.plan.headline.revision, { revision: plan.revision })}
        </span>
        {summary ? (
          <span className="font-normal text-muted-foreground">{` · ${summary}`}</span>
        ) : null}
      </h2>
      <p
        className={`inline-flex items-center gap-2 font-medium ${notFunded > 0 ? "text-status-warning-fg" : "text-status-success-fg"}`}
        data-testid="plan-funded"
      >
        {notFunded > 0 ? (
          <TriangleAlert aria-hidden="true" className="size-4" />
        ) : (
          <CircleCheck aria-hidden="true" className="size-4" />
        )}
        {notFunded > 0
          ? fill(t.plan.headline.notFunded, { count: notFunded })
          : t.plan.headline.allFunded}
      </p>
      <p data-testid="plan-trigger">{trigger}</p>
      <p className="text-sm text-muted-foreground">
        {fill(t.plan.headline.planned, { when: when(plan.planned_at) })}
        {SEP}
        <span className="font-mono" data-testid="plan-inputs-hash">
          {fill(t.plan.headline.inputs, { hash: shortHash(plan.inputs_hash) })}
        </span>
        {SEP}
        {fill(t.plan.headline.policy, {
          version: plan.policy_version,
          hash: shortHash(plan.policy_hash),
        })}
      </p>
      <p className="text-sm font-medium" data-testid="plan-waiting">
        {waiting > 0 ? fill(t.plan.headline.waiting, { count: waiting }) : t.plan.noneNeedsApproval}
      </p>
    </section>
  );
}

// ---- explanation -----------------------------------------------------------------------------

export function Explanation({ plan }: { plan: PlanBlockDto }) {
  return (
    <Card title={t.plan.explanation.title} headingId="plan-explanation" testId="plan-explanation">
      {plan.explanation !== null ? (
        <p className="max-w-[70ch] text-pretty" data-testid="explanation-text">
          {plan.explanation}
        </p>
      ) : (
        <div className="flex flex-col gap-2" data-testid="explanation-raw">
          <p role="status" className="text-sm text-status-warning-fg">
            {t.plan.explanation.unverified}
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {plan.actions.map((a) => (
              <li key={a.id}>
                <span className="font-medium">{actionTitle(a)}</span>
                {`: ${reasonText(a)}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// ---- balances --------------------------------------------------------------------------------

function BalanceTable({
  now,
  before,
  revision,
  previousRevision,
}: {
  now: BalanceRowDto;
  before: BalanceRowDto | null;
  revision: number;
  previousRevision: number | null;
}) {
  const c = now.currency;
  const pick = (r: BalanceRowDto | null, key: keyof BalanceRowDto) =>
    r === null ? null : BigInt(r[key]);
  const rows = [
    { key: "available", label: t.plan.balances.available, field: "available_minor" },
    { key: "held", label: t.plan.balances.held, field: "held_minor", unavailable: true },
    { key: "floor", label: t.plan.balances.floor, field: "reserve_floor_minor" },
    { key: "projected", label: t.plan.balances.projected, field: "projected_minor" },
  ] as const;
  return (
    <section aria-label={c} data-testid={`balances-${c}`} className="flex flex-col gap-1">
      <h3 className="font-medium">{c}</h3>
      <dl className="flex flex-col divide-y divide-border text-sm">
        {rows.map((r) => {
          const nowV = BigInt(now[r.field]);
          const beforeV = pick(before, r.field);
          const delta = beforeV === null ? null : nowV - beforeV;
          return (
            <div key={r.key} className="flex flex-col gap-0.5 py-2" data-row={r.key}>
              <dt className="inline-flex items-center gap-1.5 text-muted-foreground">
                {"unavailable" in r ? (
                  <Lock aria-hidden="true" className="size-3.5 text-status-held-fg" />
                ) : null}
                {r.label}
              </dt>
              <dd className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 tabular-nums">
                {beforeV !== null && previousRevision !== null ? (
                  <span className="text-muted-foreground">
                    {fill(t.plan.balances.was, {
                      revision: previousRevision,
                      amount: money(beforeV, c),
                    })}
                  </span>
                ) : null}
                <span className="font-medium">
                  {previousRevision !== null
                    ? fill(t.plan.balances.is, { revision, amount: money(nowV, c) })
                    : money(nowV, c)}
                </span>
                {delta !== null ? (
                  <span data-testid={`delta-${r.key}`}>
                    {delta === 0n ? (
                      <span className="text-muted-foreground">{t.plan.balances.unchanged}</span>
                    ) : (
                      <>
                        <span aria-hidden="true">{signedMoney(delta, c)}</span>
                        <span className="sr-only">
                          {fill(
                            delta > 0n
                              ? t.plan.balances.moreAvailable
                              : t.plan.balances.lessAvailable,
                            { amount: money(delta > 0n ? delta : -delta, c) },
                          )}
                        </span>
                      </>
                    )}
                  </span>
                ) : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

export function BalancesCard({ plan }: { plan: PlanBlockDto }) {
  const before = new Map((plan.previous_balances ?? []).map((b) => [b.currency, b]));
  return (
    <Card title={t.plan.balances.title} headingId="plan-balances" testId="plan-balances">
      <p className="text-sm text-muted-foreground">
        {fill(t.plan.balances.asOf, { when: when(plan.planned_at) })}
        {` ${t.plan.balances.heldNote}`}
      </p>
      {plan.balances.length === 0 ? (
        <p className="text-sm">{t.plan.balances.none}</p>
      ) : (
        <div className="flex flex-col gap-5">
          {plan.balances.map((b) => (
            <BalanceTable
              key={b.currency}
              now={b}
              before={plan.previous_revision === null ? null : (before.get(b.currency) ?? null)}
              revision={plan.revision}
              previousRevision={plan.previous_revision}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

// ---- obligations -----------------------------------------------------------------------------

export function ObligationsCard({
  plan,
  canAct,
  onChanged,
}: {
  plan: PlanBlockDto;
  canAct: boolean;
  onChanged: () => void;
}) {
  return (
    <Card title={t.plan.obligations.title} headingId="plan-obligations" testId="plan-obligations">
      <ul className="flex flex-col divide-y divide-border">
        {plan.obligations.map((o) => (
          <ObligationRow
            key={o.id}
            o={o}
            canAct={canAct}
            onChanged={onChanged}
            comparing={plan.previous_revision !== null}
          />
        ))}
      </ul>
    </Card>
  );
}

function ObligationRow({
  o,
  canAct,
  onChanged,
  comparing,
}: {
  o: ObligationRowDto;
  canAct: boolean;
  onChanged: () => void;
  comparing: boolean;
}) {
  const fate =
    o.fate === "deferred" && o.proposed_due_at
      ? fill(t.plan.fate.deferredTo, { date: day(o.proposed_due_at) })
      : fateLabel(o.fate);
  return (
    <li
      className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
      data-testid="obligation-row"
      data-obligation={o.id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="font-medium">{o.payee}</p>
        <p className="tabular-nums">{money(o.amount_minor, o.currency)}</p>
      </div>
      <p className="text-sm text-muted-foreground">
        {fill(t.plan.obligations.due, { date: day(o.due_at) })}
      </p>
      <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="obligation-fate">
        <span className="rounded-sm border border-border bg-muted px-2 py-0.5 font-medium">
          {fate}
        </span>
        {comparing && o.changed ? (
          <span
            className="inline-flex items-center gap-1 font-medium text-status-warning-fg"
            data-testid="obligation-changed"
          >
            {o.previous_fate ? (
              <>
                {fill(t.plan.obligations.changedFrom, { from: fateLabel(o.previous_fate) })}
                <ArrowRight aria-hidden="true" className="size-3.5" />
              </>
            ) : (
              t.plan.obligations.newInPlan
            )}
          </span>
        ) : null}
      </p>
      {o.criticality ? <CriticalityControl o={o} canAct={canAct} onChanged={onChanged} /> : null}
    </li>
  );
}

// ---- actions ---------------------------------------------------------------------------------

function ActionLines({ a }: { a: ActionDto }) {
  switch (a.kind) {
    case "convert": {
      const p = a.params as Extract<ActionDto["params"], { sell_currency: string }>;
      return (
        <>
          <p className="tabular-nums" data-testid="action-amounts">
            {fill(t.plan.action.convertLine, {
              sell: money(p.sell_minor, p.sell_currency),
              buy: money(p.buy_minor, p.buy_currency),
            })}
          </p>
          <p className="text-sm text-muted-foreground">
            {fill(t.plan.action.rateLine, { rate: p.rate, low: p.rate_low, high: p.rate_high })}
          </p>
        </>
      );
    }
    case "fund":
    case "payout": {
      const p = a.params as Extract<ActionDto["params"], { reserved_minor: string }>;
      return (
        <p className="tabular-nums" data-testid="action-amounts">
          {fill(t.plan.action.payLine, {
            amount: money(p.amount_minor, p.currency),
            fee: money(p.fee_minor, p.currency),
            reserved: money(p.reserved_minor, p.currency),
          })}
        </p>
      );
    }
    case "defer": {
      const p = a.params as Extract<ActionDto["params"], { proposed_due_at: string }>;
      return (
        <p data-testid="action-amounts">
          {fill(t.plan.action.deferLine, {
            amount: money(p.amount_minor, p.currency),
            from: day(p.current_due_at),
            to: day(p.proposed_due_at),
          })}
        </p>
      );
    }
    case "escalate": {
      const p = a.params as Extract<ActionDto["params"], { shortfall_minor: string }>;
      return (
        <p className="tabular-nums" data-testid="action-amounts">
          {fill(t.plan.action.escalateLine, {
            amount: money(p.amount_minor, p.currency),
            shortfall: money(p.shortfall_minor, p.currency),
          })}
        </p>
      );
    }
  }
}

function actionTitle(a: ActionDto): string {
  const title = t.plan.action.title;
  switch (a.kind) {
    case "convert": {
      const p = a.params as { sell_currency: string; buy_currency: string };
      return fill(title.convert, { sell: p.sell_currency, buy: p.buy_currency });
    }
    default: {
      const p = a.params as { payee: string };
      return fill(title[a.kind], { payee: p.payee });
    }
  }
}

function approveName(a: ActionDto): string {
  if (a.kind === "convert") {
    const p = a.params as { sell_currency: string; sell_minor: string; buy_currency: string };
    return fill(t.plan.action.approveConvert, {
      amount: money(p.sell_minor, p.sell_currency),
      buy: p.buy_currency,
    });
  }
  const p = a.params as { payee: string; amount_minor: string; currency: string };
  return fill(t.plan.action.approvePayout, {
    amount: money(p.amount_minor, p.currency),
    payee: p.payee,
  });
}

export function ActionCard({
  a,
  canAct,
  airwallexUnreachable,
  stale,
  onApprove,
}: {
  a: ActionDto;
  stale: boolean;
  canAct: boolean;
  airwallexUnreachable: boolean;
  onApprove: (a: ActionDto) => void;
}) {
  const status = actionStatus(a);
  const auto = a.auto;
  const readOnly = !canAct || stale;
  const blocked = a.approvable && a.bound === null;
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-4"
      data-testid="action-card"
      data-kind={a.kind}
      data-state={a.state}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="font-semibold">{actionTitle(a)}</h3>
        <StatusBadge status={status} />
      </div>
      <ActionLines a={a} />
      <p className="text-sm text-muted-foreground" data-testid="action-reason">
        <span className="font-medium text-foreground">{t.plan.action.why}</span> {reasonText(a)}
      </p>
      {status.key === "recommended" || status.key === "not-auto" ? (
        <p className="text-sm text-muted-foreground">{status.hint}</p>
      ) : null}
      {auto ? (
        <p className="text-sm" data-testid="action-auto">
          {fill(t.plan.action.autoUnderPolicy, {
            version: auto.policy_version,
            hash: shortHash(auto.policy_hash),
          })}
          {auto.remaining_minor !== null
            ? ` ${fill(t.plan.action.limitRemaining, {
                cap: money(auto.cap_minor ?? "0", auto.currency),
                left: money(auto.remaining_minor, auto.currency),
              })}`
            : ""}
        </p>
      ) : null}
      {a.state === "EXECUTING" || a.state === "APPROVED" ? (
        <p className="text-sm" data-testid="action-waiting">
          {a.state === "EXECUTING" ? t.plan.action.waitingExecuting : t.plan.action.waitingApproved}
        </p>
      ) : null}
      {a.state === "FAILED" ? (
        <p className="text-sm text-muted-foreground">{t.plan.action.failedNoRetry}</p>
      ) : null}
      {a.state === "FAILED" && a.state_reason ? (
        <p role="status" className="text-sm text-status-danger-fg">
          {fill(t.plan.action.failedBecause, { reason: a.state_reason })}
        </p>
      ) : null}
      {a.approved_at ? (
        <p className="text-sm text-muted-foreground">
          {fill(t.plan.action.approvedAt, { when: when(a.approved_at) })}
        </p>
      ) : null}
      {a.approvable ? (
        <div className="flex flex-col gap-1 pt-1">
          <Button
            type="button"
            className="h-auto w-full whitespace-normal py-2 text-center sm:w-fit"
            disabled={readOnly || blocked}
            aria-describedby={readOnly || blocked ? `approve-note-${a.id}` : undefined}
            onClick={() => onApprove(a)}
            data-testid="approve-button"
          >
            {approveName(a)}
          </Button>
          {readOnly ? (
            <p id={`approve-note-${a.id}`} className="text-sm text-muted-foreground">
              {stale && canAct ? t.plan.action.staleNote : t.plan.action.viewerNote}
            </p>
          ) : blocked ? (
            <p id={`approve-note-${a.id}`} className="text-sm text-muted-foreground">
              {airwallexUnreachable
                ? t.plan.action.detailsUnreachable
                : t.plan.action.detailsUnavailable}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

const AUTO_STATES = ["APPROVED", "AUTO_APPROVED", "EXECUTING", "DONE", "FAILED"];

export function ActionLists({
  plan,
  canAct,
  onApprove,
  airwallexUnreachable,
  stale,
}: {
  stale: boolean;
  plan: PlanBlockDto;
  canAct: boolean;
  onApprove: (a: ActionDto) => void;
  airwallexUnreachable: boolean;
}) {
  const needs = plan.actions.filter((a) => a.approvable);
  const auto = plan.actions.filter((a) => !a.approvable && AUTO_STATES.includes(a.state));
  const rest = plan.actions.filter((a) => !a.approvable && !AUTO_STATES.includes(a.state));
  const list = (items: ActionDto[]) => (
    <ul className="flex flex-col gap-3">
      {items.map((a) => (
        <ActionCard
          key={a.id}
          a={a}
          canAct={canAct}
          airwallexUnreachable={airwallexUnreachable}
          stale={stale}
          onApprove={onApprove}
        />
      ))}
    </ul>
  );
  return (
    <>
      <Card
        title={t.plan.section.needsApproval}
        headingId="plan-needs-approval"
        testId="plan-needs-approval"
      >
        {needs.length === 0 ? <p className="text-sm">{t.plan.noneNeedsApproval}</p> : list(needs)}
      </Card>
      {auto.length > 0 ? (
        <Card title={t.plan.section.auto} headingId="plan-auto" testId="plan-auto">
          {list(auto)}
        </Card>
      ) : null}
      <Card title={t.plan.section.actions} headingId="plan-actions" testId="plan-actions">
        {rest.length === 0 ? <p className="text-sm">{t.plan.noOtherActions}</p> : list(rest)}
      </Card>
    </>
  );
}

/** "What changed since revision N": the obligations whose fate moved, as a collapsible list. */
export function WhatChanged({ plan }: { plan: PlanBlockDto }) {
  if (plan.previous_revision === null) return null;
  const moved = plan.obligations.filter((o) => o.changed);
  return (
    <section
      aria-labelledby="plan-changed"
      data-testid="plan-what-changed"
      className="rounded-md border border-border bg-card p-4 md:p-6"
    >
      <details open>
        <summary className="min-h-11 cursor-pointer py-2 md:min-h-0">
          <h2 id="plan-changed" className="inline text-lg leading-tight font-semibold">
            {fill(t.plan.section.changed, { revision: plan.previous_revision })}
          </h2>
        </summary>
        {moved.length === 0 ? (
          <p className="pt-2 text-sm">{t.plan.changedNothing}</p>
        ) : (
          <ul className="flex flex-col gap-2 pt-2 text-sm">
            {moved.map((o) => (
              <li key={o.id}>
                {fill(t.plan.changedLine, {
                  payee: o.payee,
                  from: o.previous_fate ? fateLabel(o.previous_fate) : t.plan.obligations.newInPlan,
                  to: fateLabel(o.fate),
                })}
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
