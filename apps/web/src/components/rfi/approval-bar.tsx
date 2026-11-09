"use client";

import { CircleCheck, CircleDashed, LoaderCircle, OctagonX, TriangleAlert } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { HoldView } from "@/server/hold";
import { fill, t } from "@/strings";
import type { Gate, GateReason } from "./view";

const GATE_TEXT: Record<GateReason, (gate: Gate, view: HoldView) => string> = {
  VIEWER: () => t.hold.approval.viewer,
  EXPIRED: () => t.hold.expired.title,
  NOT_READY: (_g, v) =>
    fill(t.hold.approval.notReady, {
      state: t.hold.states[v.rfi.state as keyof typeof t.hold.states] ?? v.rfi.state,
    }),
  DRAFTING: () => t.hold.approval.draftingWait,
  NEEDS_OWNER: (g) =>
    g.blocking.length === 1
      ? fill(t.hold.approval.blocked, { count: 1 })
      : fill(t.hold.approval.blockedMany, { count: g.blocking.length }),
  STALE_DATA: () => t.hold.approval.staleDisabled,
  KILL_SWITCH: () => t.hold.approval.killSwitch,
  TOO_CLOSE: () => t.hold.approval.tooClose,
  SOURCE_FAILED: () => t.hold.source.failed,
  NO_DRAFT: () => t.hold.approval.draftingWait,
  APPROVAL_PENDING: () => t.hold.approval.approvedWaiting,
  ANSWERED: () => t.hold.approval.submitted,
};

function Step({ done, label, active }: { done: boolean; label: string; active?: boolean }) {
  const Icon = done ? CircleCheck : active ? LoaderCircle : CircleDashed;
  return (
    <li className="flex items-center gap-2 text-sm">
      <Icon
        aria-hidden="true"
        className={cn("size-4", done ? "text-status-success-fg" : "text-muted-foreground")}
      />
      <span className={cn(!done && "text-muted-foreground")}>{label}</span>
    </li>
  );
}

/**
 * ApprovalBar: sticky at the bottom of the content column. States: ready (one primary action),
 * blocked (explains why, links to the first blocking question), waiting (step list after approval,
 * server-confirmed only), done. Status text is a `role="status"`, a failed submit is an alert.
 */
export function ApprovalBar({
  view,
  gate,
  onApprove,
  onGoto,
  onWithdraw,
  withdrawing,
  count,
}: {
  view: HoldView;
  gate: Gate;
  onApprove: () => void;
  onGoto: (position: number) => void;
  onWithdraw: () => void;
  withdrawing: boolean;
  count: number;
}) {
  const reasonId = useId();
  const state = view.rfi.state;
  const waiting = state === "APPROVED" || state === "ANSWER_SUBMITTING";
  const finished = state === "ANSWERED" || state === "CLOSED";
  const expired = state === "EXPIRED" || view.rfi.expired;
  const attempt = view.attempt;
  const sent =
    attempt !== null && ["SENT_TO_AIRWALLEX", "CONFIRMED", "UNKNOWN"].includes(attempt.status);
  const label =
    count === 1 ? t.hold.approval.ctaCountOne : fill(t.hold.approval.ctaCount, { count });
  const priorEnded =
    view.approval &&
    !waiting &&
    !finished &&
    ["EXPIRED", "REJECTED"].includes(view.approval.status);

  if (expired) return null; // the page carries the expired alert; approve is removed

  return (
    <section
      aria-label={t.hold.approval.heading}
      data-testid="approval-bar"
      className="sticky bottom-14 z-10 -mx-4 mt-6 border-t border-border bg-card px-4 py-3 shadow-2 md:bottom-0 md:mx-0 md:rounded-md md:border md:px-6"
    >
      {waiting || finished ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="text-sm font-medium" data-testid="approval-status">
            {finished
              ? t.hold.approval.submitted
              : attempt?.status === "UNKNOWN"
                ? t.hold.approval.unknownWait
                : t.hold.approval.approvedWaiting}
          </p>
          <ol className="flex flex-wrap gap-x-6 gap-y-1" aria-label={t.hold.approval.heading}>
            <Step done label={t.hold.steps.approved} />
            <Step
              done={sent || finished}
              label={t.hold.steps.sent}
              active={state === "ANSWER_SUBMITTING"}
            />
            <Step done={finished} label={t.hold.steps.confirming} active={sent && !finished} />
          </ol>
          {attempt?.status === "REJECTED" && attempt.message ? (
            <p role="alert" className="text-sm text-status-danger-fg">
              {t.hold.error.submitRejected}
              <span className="block break-words">
                {fill(t.hold.error.submitDetails, { message: attempt.message })}
              </span>
            </p>
          ) : null}
          {state === "APPROVED" &&
          view.approval?.status === "APPROVED" &&
          view.role !== "viewer" ? (
            <div>
              <Button variant="outline" onClick={onWithdraw} disabled={withdrawing}>
                {withdrawing ? t.hold.approval.withdrawing : t.hold.approval.withdraw}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p
              id={reasonId}
              role="status"
              data-testid="approval-reason"
              className={cn(
                "flex items-start gap-2 text-sm",
                gate.enabled ? "text-muted-foreground" : "font-medium text-status-warning-fg",
              )}
            >
              {gate.enabled ? null : (
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              )}
              {gate.enabled
                ? t.hold.approval.readySummary
                : GATE_TEXT[gate.reason ?? "NOT_READY"](gate, view)}
            </p>
            {priorEnded ? (
              <p role="status" className="flex items-start gap-2 text-sm text-status-danger-fg">
                <OctagonX aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                {view.approval?.status === "EXPIRED"
                  ? t.hold.approval.expired
                  : t.hold.approval.invalidated}
              </p>
            ) : null}
            {gate.reason === "NEEDS_OWNER" && gate.blocking[0] !== undefined ? (
              <button
                type="button"
                onClick={() => onGoto(gate.blocking[0] ?? 1)}
                className="min-h-11 w-fit rounded-sm text-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring md:min-h-6"
              >
                {fill(t.hold.approval.blockedGo, { position: gate.blocking[0] })}
              </button>
            ) : null}
          </div>
          {gate.reason === "VIEWER" ? null : (
            <Button
              size="lg"
              aria-disabled={!gate.enabled}
              aria-describedby={reasonId}
              data-testid="approve-button"
              onClick={() => {
                if (gate.enabled) onApprove();
              }}
              className={cn("w-full md:w-auto", !gate.enabled && "cursor-not-allowed opacity-60")}
            >
              {label}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
