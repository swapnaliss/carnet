import type { SwitchChange } from "@carnet/db";
import { CirclePause } from "lucide-react";
import { MetricCard } from "@/components/ops/metric-card";
import { SwitchControl } from "@/components/ops/switch-control";
import { formatDate } from "@/lib/intl";
import type { GovernanceView } from "@/server/ops-governance";
import { fill, locale, t } from "@/strings";

const NANO = 1_000_000_000;

/** Nano-USD as dollars, to a tenth of a cent (a single call costs a fraction of a cent). */
export function formatUsdNano(nano: number): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(nano / NANO);
}

function changeText(change: SwitchChange | null, names: Map<string, string>): string {
  if (!change) return t.ops.governance.neverChanged;
  const who = change.actorId ? (names.get(change.actorId) ?? change.actorId) : "Carnet";
  return `${t.ops.governance.changedBy} ${who} ${t.ops.governance.changedAt} ${formatDate(change.at, locale, { dateStyle: "medium", timeStyle: "medium" })} ${t.ops.utc}`;
}

const BREAKER_LABEL = {
  CLOSED: () => t.ops.governance.breakerClosed,
  OPEN: () => t.ops.governance.breakerOpen,
  HALF_OPEN: () => t.ops.governance.breakerHalfOpen,
} as const;

export function Governance({ view, canChange }: { view: GovernanceView; canChange: boolean }) {
  const g = t.ops.governance;
  const names = view.names;
  const spend = view.spend;
  const paused = [
    ...(view.agentsEnabled ? [] : [g.pausedAgents]),
    ...(view.executionEnabled ? [] : [g.pausedExecution]),
  ];
  return (
    <>
      {paused.length > 0 ? (
        <div
          role="alert"
          data-testid="paused-banner"
          className="flex items-start gap-3 rounded-md border border-border bg-status-danger-bg p-4 text-status-danger-fg"
        >
          <CirclePause aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <p>{fill(g.pausedBanner, { what: paused.join(" and ") })}</p>
        </div>
      ) : null}
      <section aria-labelledby="ops-switches" className="flex flex-col gap-3">
        <h2 id="ops-switches" className="text-lg leading-tight font-semibold">
          {g.switchesTitle}
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <SwitchControl
            flag="agents_enabled"
            enabled={view.agentsEnabled}
            canChange={canChange}
            lastChange={changeText(view.agentsChange, names)}
          />
          <SwitchControl
            flag="execution_enabled"
            enabled={view.executionEnabled}
            canChange={canChange}
            lastChange={changeText(view.executionChange, names)}
          />
        </div>
      </section>

      <section aria-labelledby="ops-spend" className="flex flex-col gap-3">
        <h2 id="ops-spend" className="text-lg leading-tight font-semibold">
          {g.spendTitle}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <MetricCard
            id="spend-today"
            title={g.spendToday}
            value={formatUsdNano(spend.todayNanoUsd)}
            definition={g.spendTodayDefinition}
            window={`${g.spendDailyCap}: ${formatUsdNano(view.dailyCapNanoUsd)}`}
          />
          <MetricCard
            id="spend-daily-cap"
            title={g.spendDailyCap}
            value={formatUsdNano(view.dailyCapNanoUsd)}
            definition={g.spendCapDefinition}
            window={g.spendTitle}
          />
          <MetricCard
            id="spend-per-run-cap"
            title={g.spendPerRunCap}
            value={formatUsdNano(view.perRunCapNanoUsd)}
            definition={g.spendPerRunCapDefinition}
            window={g.spendTitle}
          />
          <MetricCard
            id="spend-largest-run"
            title={g.spendLargestRun}
            value={formatUsdNano(spend.largestRunTodayNanoUsd)}
            detail={`${spend.runsToday} ${g.spendRuns}`}
            definition={g.spendLargestRunDefinition}
            window={g.spendTitle}
          />
          <MetricCard
            id="spend-total"
            title={g.spendTotal}
            value={formatUsdNano(spend.totalNanoUsd)}
            definition={g.spendTotalDefinition}
            window={g.spendAllTime}
          />
        </div>
      </section>

      <section aria-labelledby="ops-breakers" className="flex flex-col gap-3">
        <h2 id="ops-breakers" className="text-lg leading-tight font-semibold">
          {g.breakersTitle}
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          {view.breakers.map((b) => (
            <MetricCard
              key={b.dependency}
              id={`breaker-${b.dependency}`}
              title={b.dependency === "airwallex" ? g.breakerAirwallex : g.breakerModel}
              value={
                b.state === "CLOSED" && b.samplesInWindow === 0
                  ? g.breakerNoCalls
                  : BREAKER_LABEL[b.state]()
              }
              detail={
                `${b.failuresInWindow} ${g.breakerFailures} (${b.samplesInWindow} ${g.breakerSamples})` +
                (b.retryAt
                  ? `. ${g.breakerRetryAt} ${formatDate(b.retryAt, locale, { timeStyle: "medium" })} ${t.ops.utc}`
                  : "")
              }
              definition={g.breakerDefinition}
              window={g.breakersTitle}
            />
          ))}
        </div>
      </section>
    </>
  );
}
