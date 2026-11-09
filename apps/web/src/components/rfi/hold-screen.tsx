"use client";

import { ArrowLeft, Info, OctagonX, PauseCircle, ShieldAlert, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { announce } from "@/components/payments/announce";
import { describeStatus, formatWhen, formatWire } from "@/components/payments/format";
import { LiveIndicator, StaleBanner } from "@/components/payments/live-status";
import { StatusBadge } from "@/components/payments/status-badge";
import { POLL_MS, useNow, usePoll } from "@/components/payments/use-poll";
import { EmptyState } from "@/components/shell/empty-state";
import type { HoldView } from "@/server/hold";
import type { PaymentDto } from "@/server/payments";
import { fill, t } from "@/strings";
import { ApprovalBar } from "./approval-bar";
import { ApproveDialog, type ApproveSnapshot, makeSnapshot } from "./approve-dialog";
import { LinkPayment } from "./link-payment";
import { QuestionCard, QuestionStatusChip } from "./question-card";
import { approveGate, countQuestions, describeChange, questionStatus, shortId } from "./view";

const TERMINAL = ["ANSWERED", "CLOSED", "EXPIRED"];
const stateLabel = (state: string) => t.hold.states[state as keyof typeof t.hold.states] ?? state;

function Callout({
  tone,
  icon: Icon,
  title,
  children,
  testId,
}: {
  tone: "warning" | "danger" | "default";
  icon: typeof Info;
  title?: string;
  children: ReactNode;
  testId?: string;
}) {
  const colors =
    tone === "danger"
      ? "bg-status-danger-bg text-status-danger-fg"
      : tone === "warning"
        ? "bg-status-warning-bg text-status-warning-fg"
        : "bg-status-progress-bg text-status-progress-fg";
  return (
    <section
      data-testid={testId}
      className={`flex gap-3 rounded-md border border-border p-4 ${colors}`}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="flex flex-col gap-1 text-sm">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children}
      </div>
    </section>
  );
}

function transferBadge(view: HoldView) {
  const p = view.payment;
  if (!p) return null;
  const dto = {
    transfer_status: p.transfer_status,
    failure_type: null,
    attempt: null,
  } as unknown as PaymentDto;
  return describeStatus(dto);
}

function deadlineText(expiresAt: string | null, now: number) {
  if (!expiresAt) return { when: t.hold.header.deadlineNone, relative: null };
  const ms = new Date(expiresAt).getTime() - now;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.max(0, Math.floor((ms % 3_600_000) / 60_000));
  const relative = ms <= 0 ? null : hours >= 1 ? `${hours} h` : `${Math.max(1, minutes)} min`;
  return { when: fill(t.hold.header.deadline, { when: formatWhen(expiresAt) }), relative };
}

export function HoldScreen({ initial }: { initial: HoldView }) {
  const rfiId = initial.rfi.id;
  const poll = usePoll<HoldView>(`/api/v1/rfis/${rfiId}/hold`, initial, POLL_MS, {
    // Stops once the RFI reached a final state; every other state keeps looking (3 s, backs off).
    enabled: !TERMINAL.includes(initial.rfi.state),
    backoff: true,
  });
  const view = poll.data;
  const now = useNow(1000);
  const settled = TERMINAL.includes(view.rfi.state);
  const [selected, setSelected] = useState(0);
  const [activeSnippet, setActiveSnippet] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ApproveSnapshot | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const previous = useRef(initial);

  // Announce transitions only (never polls): the shell's one polite live region.
  useEffect(() => {
    const before = previous.current;
    previous.current = view;
    const change = describeChange(before, view);
    if (!change) return;
    const c = countQuestions(view);
    if (view.rfi.state === "ANSWERED") announce(t.hold.live.answered);
    else if (view.rfi.state === "APPROVED") announce(t.hold.live.approved);
    else if (change === "state" && c.drafting === 0 && view.draft)
      announce(
        c.needs > 0
          ? fill(t.hold.live.needsYou, { count: c.needs })
          : fill(t.hold.live.draftReady, { ready: c.ready, total: c.total }),
      );
    else announce(fill(t.hold.live.stateChanged, { state: stateLabel(view.rfi.state) }));
  }, [view]);

  const gate = useMemo(
    () => approveGate(view, { now, lastSuccessAt: poll.lastSuccessAt }),
    [view, now, poll.lastSuccessAt],
  );
  const counts = countQuestions(view);

  const goto = useCallback(
    (index: number) => {
      setSelected(index);
      const el = document.getElementById(`q-${view.questions[index]?.id}-title`);
      el?.focus();
      el?.scrollIntoView({ block: "start" });
    },
    [view.questions],
  );

  // Alt+Down / Alt+Up jump between questions (docs/design/screens/hold-screen.md "Keyboard").
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
      e.preventDefault();
      const next = Math.min(
        view.questions.length - 1,
        Math.max(0, selected + (e.key === "ArrowDown" ? 1 : -1)),
      );
      goto(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goto, selected, view.questions.length]);

  async function withdraw() {
    if (!view.approval || withdrawing) return;
    setWithdrawing(true);
    try {
      await fetch(`/api/v1/rfis/${rfiId}/approvals/${view.approval.id}/reject`, { method: "POST" });
    } finally {
      setWithdrawing(false);
      poll.checkNow();
    }
  }

  const canAct = view.role !== "viewer";
  const state = view.rfi.state;
  const canEdit = canAct && (state === "DRAFT_READY" || state === "NEEDS_OWNER");
  const lockedReason = !canAct
    ? t.hold.approval.viewer
    : state === "APPROVED"
      ? t.hold.approval.editingLocked
      : null;
  const badge = transferBadge(view);
  const deadline = deadlineText(view.rfi.expires_at, now);
  const expired = state === "EXPIRED" || view.rfi.expired;
  const answered = state === "ANSWERED" || state === "CLOSED";
  const polling = !settled;

  if (view.questions.length === 0 && state !== "DRAFTING" && state !== "ACTION_REQUIRED") {
    return (
      <EmptyState
        icon={Info}
        title={t.hold.empty.title}
        body={t.hold.empty.body}
        action={
          <Link
            href="/rfis"
            className="min-h-11 font-medium text-primary underline underline-offset-4"
          >
            {t.hold.empty.cta}
          </Link>
        }
        headingLevel={1}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="hold-screen" data-rfi-state={state}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/rfis"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-sm text-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring md:min-h-6"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t.hold.header.back}
        </Link>
        {polling ? (
          <LiveIndicator
            lastSuccessAt={poll.lastSuccessAt}
            failures={poll.failures}
            paused={poll.paused}
            now={now}
          />
        ) : null}
      </div>

      <header className="flex flex-col gap-3">
        <h1 className="text-xl leading-tight font-semibold md:text-2xl" tabIndex={-1}>
          {view.payment
            ? (view.payment.counterparty ?? view.payment.reference)
            : t.hold.header.unlinked}
        </h1>
        {view.payment ? (
          <>
            <p className="text-2xl font-semibold tabular-nums" data-testid="hold-amount">
              {formatWire(view.payment.amount)}
            </p>
            <p className="text-sm text-muted-foreground">{view.payment.reference}</p>
            <div className="flex flex-wrap items-center gap-2" data-testid="hold-badges">
              {view.payment.held ? (
                <span
                  data-status="held"
                  className="inline-flex min-h-7 items-center gap-1.5 rounded-sm border border-border bg-status-held-bg px-2.5 text-sm font-medium text-status-held-fg"
                >
                  <PauseCircle aria-hidden="true" className="size-4" />
                  {t.hold.status.held.label}
                  <span className="sr-only">{`. ${t.hold.status.held.hint}`}</span>
                </span>
              ) : null}
              {badge ? <StatusBadge status={badge} size="md" /> : null}
            </div>
            <p className="max-w-[65ch] text-sm text-muted-foreground">
              {t.hold.header.heldExplainer}
            </p>
          </>
        ) : canAct ? (
          <LinkPayment rfiId={rfiId} />
        ) : null}
        <p
          className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground"
          data-testid="hold-rfi-line"
        >
          <span className="font-mono" title={view.rfi.airwallex_rfi_id}>
            {fill(t.hold.header.rfiId, { id: shortId(view.rfi.airwallex_rfi_id) })}
          </span>
          <span>{fill(t.hold.header.round, { round: view.rfi.round })}</span>
          <span data-testid="hold-deadline">
            {deadline.when}
            {deadline.relative
              ? ` (${fill(t.hold.header.deadlineRelative, { relative: deadline.relative })})`
              : ""}
          </span>
        </p>
        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer rounded-sm py-2 font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring md:min-h-6 md:py-0">
            {t.hold.header.rfiDetails}
          </summary>
          <dl className="mt-2 grid max-w-md grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{t.hold.header.type}</dt>
            <dd>{view.rfi.type}</dd>
            <dt className="text-muted-foreground">{t.hold.header.airwallexStatus}</dt>
            <dd className="font-mono">{view.rfi.airwallex_status}</dd>
            <dt className="text-muted-foreground">{t.hold.header.carnetState}</dt>
            <dd>{stateLabel(state)}</dd>
            {badge ? (
              <>
                <dt className="text-muted-foreground">{t.hold.header.transfer}</dt>
                <dd>{badge.label}</dd>
              </>
            ) : null}
          </dl>
        </details>
      </header>

      {polling ? (
        <StaleBanner lastSuccessAt={poll.lastSuccessAt} now={now} onCheckNow={poll.checkNow} />
      ) : null}

      {expired ? (
        <Callout tone="danger" icon={OctagonX} title={t.hold.expired.title} testId="hold-expired">
          <p>
            {fill(t.hold.expired.body, {
              date: view.rfi.expires_at
                ? formatWhen(view.rfi.expires_at)
                : formatWhen(view.rfi.airwallex_updated_at),
            })}
          </p>
        </Callout>
      ) : null}
      {!view.execution_enabled && !answered && !expired ? (
        <Callout
          tone="warning"
          icon={ShieldAlert}
          title={t.hold.killSwitch.title}
          testId="hold-killswitch"
        >
          <p>{t.hold.killSwitch.body}</p>
        </Callout>
      ) : null}
      {view.draft?.injection_flagged ? (
        <Callout tone="warning" icon={TriangleAlert} testId="hold-injection">
          <p>{t.hold.error.injection}</p>
        </Callout>
      ) : null}
      {answered ? (
        <Callout
          tone="default"
          icon={Info}
          title={
            state === "CLOSED"
              ? t.hold.outcome.closed
              : fill(t.hold.outcome.answered, {
                  time: formatWhen(view.approval?.consumed_at ?? view.rfi.airwallex_updated_at),
                })
          }
          testId="hold-answered"
        >
          <p>{t.hold.outcome.transferUnchanged}</p>
        </Callout>
      ) : null}
      {state === "DRAFTING" || state === "ACTION_REQUIRED" ? (
        <Callout tone="default" icon={Info} title={t.hold.drafting.title} testId="hold-drafting">
          <p>{t.hold.drafting.body}</p>
        </Callout>
      ) : null}

      <section aria-labelledby="questions-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h2 id="questions-heading" className="text-lg leading-tight font-semibold">
            {answered ? t.hold.outcome.readOnly : t.hold.questions.heading}
          </h2>
          <p className="text-sm text-muted-foreground" data-testid="hold-counts">
            {counts.drafting > 0
              ? fill(t.hold.summary.countsDrafting, { total: counts.total })
              : fill(t.hold.summary.counts, counts)}
          </p>
          <QuestionNav
            view={view}
            selected={selected}
            onSelect={(i) => {
              goto(i);
            }}
          />
        </div>
        <ol className="flex flex-col gap-4" aria-label={t.hold.questions.heading}>
          {view.questions.map((q, i) => (
            <QuestionCard
              key={q.id}
              view={view}
              question={q}
              position={i + 1}
              total={view.questions.length}
              selected={selected === i}
              activeSnippet={activeSnippet}
              onSnippet={setActiveSnippet}
              canEdit={canEdit}
              lockedReason={lockedReason}
              onChanged={poll.checkNow}
            />
          ))}
        </ol>
      </section>

      <details className="text-sm">
        <summary className="min-h-11 cursor-pointer rounded-sm py-2 font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring md:min-h-6 md:py-0">
          {t.hold.keyboard.label}
        </summary>
        <p className="mt-2 max-w-[65ch] text-muted-foreground">{t.hold.keyboard.body}</p>
      </details>

      <ApprovalBar
        view={view}
        gate={gate}
        count={view.questions.length}
        onApprove={() => setSnapshot(makeSnapshot(view))}
        onGoto={(position) => goto(position - 1)}
        onWithdraw={() => void withdraw()}
        withdrawing={withdrawing}
      />

      <ApproveDialog
        snapshot={snapshot}
        current={view}
        onClose={() => setSnapshot(null)}
        onApproved={() => {
          // The server recorded the approval: close, then show what the server now reports.
          setSnapshot(null);
          poll.checkNow();
        }}
        onRefresh={poll.checkNow}
      />
    </div>
  );
}

/**
 * The questions as a list of buttons with roving focus (one tab stop, arrow keys move between them,
 * Enter selects and jumps to the question). Each shows its state chip, so state is never colour alone.
 */
function QuestionNav({
  view,
  selected,
  onSelect,
}: {
  view: HoldView;
  selected: number;
  onSelect: (index: number) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const move = (to: number) => {
    const next = (to + view.questions.length) % view.questions.length;
    setFocusIndex(next);
    refs.current[next]?.focus();
  };
  return (
    <ul
      aria-label={t.hold.question.list}
      className="flex flex-col gap-1"
      data-testid="question-nav"
    >
      {view.questions.map((q, i) => (
        <li key={q.id}>
          <button
            type="button"
            ref={(el) => {
              refs.current[i] = el;
            }}
            tabIndex={focusIndex === i ? 0 : -1}
            aria-current={selected === i ? "true" : undefined}
            onFocus={() => setFocusIndex(i)}
            onClick={() => onSelect(i)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowRight") {
                e.preventDefault();
                move(i + 1);
              } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
                e.preventDefault();
                move(i - 1);
              } else if (e.key === "Home") {
                e.preventDefault();
                move(0);
              } else if (e.key === "End") {
                e.preventDefault();
                move(view.questions.length - 1);
              }
            }}
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-focus-ring aria-[current=true]:border-primary md:min-h-9"
          >
            <span className="min-w-0 break-words">
              <span className="font-medium">
                {fill(t.hold.question.select, { position: i + 1, title: q.title })}
              </span>
            </span>
            <QuestionStatusChip
              status={questionStatus(q, view.rfi.state)}
              edited={view.draft?.origin === "owner"}
            />
          </button>
        </li>
      ))}
    </ul>
  );
}
