"use client";

import { CalendarRange, CircleAlert, RefreshCw, TriangleAlert } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { announce } from "@/components/payments/announce";
import { LiveIndicator, StaleBanner } from "@/components/payments/live-status";
import { POLL_MS, useNow, usePoll } from "@/components/payments/use-poll";
import { EmptyState } from "@/components/shell/empty-state";
import { Button } from "@/components/ui/button";
import type { ActionDto, PlanView } from "@/server/plans";
import { fill, t } from "@/strings";
import { ActionLists, BalancesCard, Explanation, Headline, ObligationsCard } from "./plan-cards";
import { type ApproveSnapshot, makeSnapshot } from "./plan-dialog";

// The dialog loads when an approval starts, not with the first paint (INP and TBT budget).
const ApproveDialog = dynamic(() => import("./plan-dialog").then((m) => m.ApproveDialog), {
  ssr: false,
});

/** Slow plans re-check as often as the hold screen; nothing else is polled faster (ADR 0017). */
const WATCHING = ["APPROVED", "AUTO_APPROVED", "EXECUTING"];

function Ticking({ poll }: { poll: { lastSuccessAt: number; failures: number; paused: boolean } }) {
  const now = useNow(1000);
  return (
    <LiveIndicator
      lastSuccessAt={poll.lastSuccessAt}
      failures={poll.failures}
      paused={poll.paused}
      now={now}
    />
  );
}

function TickingStale({
  lastSuccessAt,
  onCheckNow,
}: {
  lastSuccessAt: number;
  onCheckNow: () => void;
}) {
  const now = useNow(1000);
  return <StaleBanner lastSuccessAt={lastSuccessAt} now={now} onCheckNow={onCheckNow} />;
}

function Notice({
  tone,
  testId,
  children,
  role,
}: {
  tone: "warning" | "danger" | "progress";
  testId: string;
  children: React.ReactNode;
  role?: "status" | "alert";
}) {
  const colors =
    tone === "danger"
      ? "bg-status-danger-bg text-status-danger-fg"
      : tone === "warning"
        ? "bg-status-warning-bg text-status-warning-fg"
        : "bg-status-progress-bg text-status-progress-fg";
  const Icon = tone === "danger" ? CircleAlert : TriangleAlert;
  return (
    <div
      role={role}
      data-testid={testId}
      className={`flex items-start gap-3 rounded-md border border-border p-4 text-sm ${colors}`}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="flex flex-1 flex-col items-start gap-2">{children}</div>
    </div>
  );
}

function Body({
  target,
  initial,
  onShow,
  notice,
}: {
  target: number;
  initial: PlanView;
  onShow: (revision: number | "latest", notice: "none" | "changed") => void;
  notice: "none" | "changed";
}) {
  const poll = usePoll<PlanView>(
    `/api/v1/plans/${target > 0 ? target : "current"}`,
    initial,
    POLL_MS,
    {
      backoff: true,
    },
  );
  const view = poll.data;
  const plan = view.plan;
  const [snapshot, setSnapshot] = useState<ApproveSnapshot | null>(null);
  const seenNewer = useRef<number | null>(null);

  const newer =
    plan && view.latest_revision !== null && view.latest_revision > plan.revision
      ? view.latest_revision
      : null;
  useEffect(() => {
    if (newer !== null && seenNewer.current !== newer) {
      seenNewer.current = newer;
      announce(fill(t.plan.newRevision.announce, { revision: newer }));
    }
  }, [newer]);

  const checkNow = poll.checkNow;
  const onApprove = useCallback(
    (a: ActionDto) => {
      if (plan) setSnapshot(makeSnapshot(a, plan.revision));
    },
    [plan],
  );

  if (!plan || plan.actions.length === 0) {
    return <EmptyState icon={CalendarRange} title={t.plan.empty.title} body={t.plan.empty.body} />;
  }
  const busy = plan.actions.some((a) => WATCHING.includes(a.state));

  return (
    <div className="flex flex-col gap-6" data-testid="plan-screen" data-revision={plan.revision}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Ticking poll={poll} />
        {busy ? <p className="text-sm text-muted-foreground">{t.plan.executingNote}</p> : null}
      </div>
      <TickingStale lastSuccessAt={poll.lastSuccessAt} onCheckNow={checkNow} />
      {notice === "changed" ? (
        <Notice tone="warning" testId="plan-changed-banner" role="status">
          <p className="font-semibold">{t.plan.changed.title}</p>
          <p>{fill(t.plan.changed.body, { revision: plan.revision })}</p>
        </Notice>
      ) : null}
      {newer !== null ? (
        <Notice tone="progress" testId="plan-newer-banner">
          <p className="font-semibold">{fill(t.plan.newRevision.title, { revision: newer })}</p>
          <p>{t.plan.newRevision.body}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onShow("latest", "none")}
            data-testid="plan-show-latest"
          >
            {fill(t.plan.newRevision.cta, { revision: newer })}
          </Button>
        </Notice>
      ) : null}
      {view.airwallex_unreachable ? (
        <Notice tone="warning" testId="plan-airwallex-banner" role="status">
          <p className="font-semibold">{t.plan.stale.title}</p>
          <p>{t.plan.stale.body}</p>
          <Button type="button" size="sm" variant="outline" onClick={checkNow}>
            <RefreshCw aria-hidden="true" />
            {t.common.state.stale.checkNow}
          </Button>
        </Notice>
      ) : null}
      <Headline plan={plan} />
      <Explanation plan={plan} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[7fr_5fr]">
        <div className="flex min-w-0 flex-col gap-6">
          <ActionLists
            plan={plan}
            canAct={view.can_act && plan.is_latest}
            airwallexUnreachable={view.airwallex_unreachable}
            onApprove={onApprove}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <BalancesCard plan={plan} />
          <ObligationsCard plan={plan} canAct={view.can_act} onChanged={checkNow} />
        </div>
      </div>
      <ApproveDialog
        snapshot={snapshot}
        onClose={() => setSnapshot(null)}
        onApproved={() => {
          setSnapshot(null);
          announce(t.plan.dialog.approvedAnnounce);
          checkNow();
        }}
        onRefresh={() => onShow("latest", "changed")}
      />
    </div>
  );
}

/**
 * The plan screen (docs/design/screens/plan-screen.md, M3-04). The first render is server-fetched; the
 * client then polls the same revision. A newer revision never replaces what the person is reading: a
 * banner offers it, and an approval of the old one is refused by the server. Money and approvals are
 * never updated optimistically.
 */
export function PlanScreen({ initial }: { initial: PlanView }) {
  const [shown, setShown] = useState<{
    target: number;
    view: PlanView;
    key: number;
    notice: "none" | "changed";
  }>({
    target: initial.plan?.revision ?? 0,
    view: initial,
    key: 0,
    notice: "none",
  });
  const [loadError, setLoadError] = useState(false);
  const loading = useRef(false);

  const show = useCallback(async (revision: number | "latest", notice: "none" | "changed") => {
    if (loading.current) return;
    loading.current = true;
    try {
      const res = await fetch(
        revision === "latest" ? "/api/v1/plans/current" : `/api/v1/plans/${revision}`,
        {
          cache: "no-store",
          headers: { accept: "application/json" },
        },
      );
      if (!res.ok) throw new Error(String(res.status));
      const next = (await res.json()) as PlanView;
      setLoadError(false);
      setShown((s) => ({ target: next.plan?.revision ?? 0, view: next, key: s.key + 1, notice }));
      if (next.plan) announce(fill(t.plan.newRevision.shown, { revision: next.plan.revision }));
    } catch {
      setLoadError(true);
    } finally {
      loading.current = false;
    }
  }, []);

  return (
    <>
      {loadError ? (
        <div
          role="alert"
          data-testid="plan-load-error"
          className="mb-6 flex flex-col items-start gap-2 rounded-md border border-destructive bg-card p-4"
        >
          <p className="font-semibold">{t.plan.error.title}</p>
          <p className="text-sm">{t.plan.error.body}</p>
          <Button type="button" onClick={() => void show("latest", "none")}>
            {t.common.state.retry}
          </Button>
        </div>
      ) : null}
      <Body
        key={shown.key}
        target={shown.target}
        initial={shown.view}
        notice={shown.notice}
        onShow={(r, notice) => void show(r, notice)}
      />
    </>
  );
}
