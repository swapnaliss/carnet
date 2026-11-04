import { getSloSummary, type SloSummary } from "@carnet/db";
import { Bot, CircleAlert, Link2 } from "lucide-react";
import type { Metadata } from "next";
import { forbidden } from "next/navigation";
import type { ReactNode } from "react";
import { formatCount, formatMs, MetricCard } from "@/components/ops/metric-card";
import { PageTitle } from "@/components/shell/empty-state";
import { formatDate, formatRelative } from "@/lib/intl";
import { logger } from "@/lib/logger";
import { requirePageSession } from "@/lib/page-session";
import { appDb } from "@/server/db";
import { locale, t } from "@/strings";

export const metadata: Metadata = { title: t.ops.title };
export const dynamic = "force-dynamic";

// /ops (M1-09, docs/design/screens/ops.md): service levels and health computed from database
// timestamps (packages/db/src/queries/slo.ts has the definitions). Owner and approver only; a
// viewer gets 403 and no session goes to /login. Tenant figures (incidents, unknown attempts) are
// scoped to the signed-in business; webhooks and jobs are system-wide.
// Kill switches and spend (M4-02), agent runs (M2-00) and the audit chain (M4-01) come later and
// have a labelled slot at the end.

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-lg leading-tight font-semibold">
        {title}
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{children}</div>
    </section>
  );
}

const ms = (v: number | null) => (v === null ? null : formatMs(v, locale));

function SloCards({ s }: { s: SloSummary }) {
  const now = s.generatedAt;
  const median = (v: number | null) => (v === null ? undefined : `${t.ops.slo.median} ${ms(v)}`);
  const ack = s.webhookAck;
  const beat = s.workerHeartbeat;
  const rec = s.reconcile;
  const beatStale = beat.ageMs === null || beat.ageMs > beat.maxAgeMs;
  const recStale = rec.ageMs === null || rec.ageMs > rec.maxAgeMs;
  return (
    <>
      <Section id="ops-slo" title={t.ops.slo.title}>
        <MetricCard
          id="slo-webhook-ack"
          title={t.ops.slo.webhookAck}
          value={ms(ack.p95Ms)}
          detail={median(ack.p50Ms)}
          {...(ack.meets === null
            ? {}
            : {
                verdict: ack.meets
                  ? { kind: "meets" as const, label: t.ops.slo.meets }
                  : { kind: "misses" as const, label: t.ops.slo.misses },
              })}
          definition={t.ops.slo.webhookAckDefinition}
          window={t.ops.slo.window}
          samples={ack.samples}
        />
        <MetricCard
          id="slo-job-queue"
          title={t.ops.slo.jobQueue}
          value={ms(s.jobQueue.p95Ms)}
          detail={median(s.jobQueue.p50Ms)}
          definition={t.ops.slo.jobQueueDefinition}
          window={t.ops.slo.window}
          samples={s.jobQueue.samples}
        />
        <MetricCard
          id="slo-job-processing"
          title={t.ops.slo.jobProcessing}
          value={ms(s.jobProcessing.p95Ms)}
          detail={median(s.jobProcessing.p50Ms)}
          definition={t.ops.slo.jobProcessingDefinition}
          window={t.ops.slo.window}
          samples={s.jobProcessing.samples}
        />
      </Section>

      <Section id="ops-health" title={t.ops.health.title}>
        <MetricCard
          id="health-heartbeat"
          title={t.ops.health.heartbeat}
          value={beat.lastAt === null ? null : formatRelative(beat.lastAt, now, locale)}
          {...(beatStale
            ? {
                verdict: {
                  kind: "warning" as const,
                  label:
                    beat.lastAt === null ? t.ops.health.heartbeatNone : t.ops.health.heartbeatStale,
                },
              }
            : {})}
          {...(beat.lastAt
            ? {
                detail: `${t.ops.health.lastReport} ${formatDate(beat.lastAt, locale, { timeStyle: "medium" })} ${t.ops.utc}`,
              }
            : {})}
          definition={t.ops.health.heartbeatDefinition}
          window={t.ops.slo.windowAllTime}
        />
        <MetricCard
          id="health-reconcile"
          title={t.ops.reconciler.lastRun}
          value={rec.lastAt === null ? null : formatRelative(rec.lastAt, now, locale)}
          {...(recStale
            ? {
                verdict: {
                  kind: "warning" as const,
                  label: rec.lastAt === null ? t.ops.reconciler.never : t.ops.reconciler.stale,
                },
              }
            : {})}
          definition={t.ops.reconciler.definition}
          window={t.ops.slo.windowAllTime}
        />
        <MetricCard
          id="health-queue-depth"
          title={t.ops.health.queueDepth}
          value={formatCount(s.queueDepth, locale)}
          definition={t.ops.health.queueDepthDefinition}
          window={t.ops.slo.windowNow}
        />
        <MetricCard
          id="health-dead-jobs"
          title={t.ops.health.deadJobs}
          value={formatCount(s.deadJobs.total, locale)}
          detail={`${t.ops.health.deadJobsWindow}: ${formatCount(s.deadJobs.inWindow, locale)}`}
          {...(s.deadJobs.inWindow > 0
            ? { verdict: { kind: "misses" as const, label: t.ops.slo.misses } }
            : {})}
          definition={t.ops.health.deadJobsDefinition}
          window={t.ops.slo.windowAllTime}
        />
      </Section>

      <Section id="ops-money" title={t.ops.money.title}>
        <MetricCard
          id="money-incidents"
          title={t.ops.money.incidents}
          value={formatCount(s.incidents, locale)}
          definition={t.ops.money.incidentsDefinition}
          window={t.ops.slo.window}
        />
        <MetricCard
          id="money-unknown"
          title={t.ops.money.unknown}
          value={formatCount(s.unknownAttempts, locale)}
          definition={t.ops.money.unknownDefinition}
          window={t.ops.slo.windowNow}
        />
      </Section>
    </>
  );
}

function LaterSlot({
  id,
  icon: Icon,
  title,
  body,
}: {
  id: string;
  icon: typeof Bot;
  title: string;
  body: string;
}) {
  return (
    <article
      aria-labelledby={id}
      className="flex items-start gap-3 rounded-md border border-dashed border-border p-4 md:p-5"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <div className="flex flex-col gap-1">
        <h3 id={id} className="text-base leading-snug font-semibold">
          {title}
        </h3>
        <p className="text-sm text-pretty text-muted-foreground">{body}</p>
      </div>
    </article>
  );
}

async function loadSummary(businessId: string): Promise<SloSummary | null> {
  try {
    return await getSloSummary(appDb().db, { businessId });
  } catch (error) {
    logger().error(
      { event: "ops.page.error", err: error instanceof Error ? error.message : "unknown" },
      "ops summary failed",
    );
    return null;
  }
}

export default async function OpsPage() {
  const ctx = await requirePageSession();
  if (ctx.role === "viewer") forbidden();
  const summary = await loadSummary(ctx.businessId);

  return (
    <>
      <PageTitle>{t.ops.title}</PageTitle>
      <div className="flex flex-col gap-8">
        <div className="flex max-w-[65ch] flex-col gap-1">
          <p className="text-pretty text-muted-foreground">{t.ops.intro}</p>
          {summary ? (
            <p className="text-sm text-muted-foreground tabular-nums">
              {`${t.ops.generatedAt} ${formatDate(summary.generatedAt, locale, { dateStyle: "medium", timeStyle: "medium" })} ${t.ops.utc}`}
            </p>
          ) : null}
        </div>
        {summary ? (
          <SloCards s={summary} />
        ) : (
          <div
            role="alert"
            className="flex max-w-2xl items-start gap-3 rounded-md border border-border bg-status-danger-bg p-4 text-status-danger-fg"
          >
            <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <p>{t.ops.error.panel}</p>
          </div>
        )}
        <section aria-labelledby="ops-later" className="flex flex-col gap-3">
          <h2 id="ops-later" className="text-lg leading-tight font-semibold">
            {t.ops.later.title}
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            <LaterSlot
              id="later-agent-runs"
              icon={Bot}
              title={t.ops.later.agentRuns}
              body={t.ops.later.agentRunsBody}
            />
            <LaterSlot
              id="later-audit-chain"
              icon={Link2}
              title={t.ops.later.auditChain}
              body={t.ops.later.auditChainBody}
            />
          </div>
        </section>
      </div>
    </>
  );
}
