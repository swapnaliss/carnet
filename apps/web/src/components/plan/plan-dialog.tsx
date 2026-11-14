"use client";

import { useEffect, useId, useState } from "react";
import { Modal } from "@/components/rfi/modal";
import { Button } from "@/components/ui/button";
import type { ActionDto } from "@/server/plans";
import { fill, t } from "@/strings";
import { day, money } from "./format";

export interface ApproveSnapshot {
  readonly action: ActionDto;
  readonly revision: number;
  readonly shown: Record<string, string>;
  readonly key: string;
}

export function makeSnapshot(action: ActionDto, revision: number): ApproveSnapshot | null {
  return action.bound ? { action, revision, shown: action.bound, key: crypto.randomUUID() } : null;
}

type Outcome =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "changed"; reason: "PLAN_CHANGED" | "CONTENT_CHANGED" }
  | { kind: "error"; message: string };

const FIELD_ORDER = {
  convert: ["sell_currency", "buy_currency", "sell_minor", "rate_low", "rate_high"],
  payout: [
    "source_account",
    "source_currency",
    "beneficiary_fingerprint",
    "amount_minor",
    "currency",
    "fee_option",
    "value_date",
    "reference",
    "counterparty_id",
  ],
} as const;

function display(key: string, value: string, shown: Record<string, string>): string {
  if (key === "sell_minor") return money(value, shown.sell_currency ?? "");
  if (key === "amount_minor") return money(value, shown.currency ?? "");
  if (key === "value_date") return value === "" ? t.plan.dialog.notDated : day(value);
  if (key === "beneficiary_fingerprint") return value.slice(0, 16);
  return value;
}

/**
 * The approval dialog: lists exactly the fields the approval is bound to, as rendered, and posts those
 * same strings. The server rebuilds the content from its own rows and refuses when anything differs
 * (or when the plan has moved on). Nothing is recorded as approved until the server says so.
 */
export function ApproveDialog({
  snapshot,
  onClose,
  onApproved,
  onRefresh,
}: {
  snapshot: ApproveSnapshot | null;
  onClose: () => void;
  onApproved: () => void;
  /** The plan moved or the details changed: fetch the newest plan and show it. */
  onRefresh: () => void;
}) {
  const titleId = useId();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  useEffect(() => {
    if (snapshot) setOutcome({ kind: "idle" });
  }, [snapshot]);

  const open = snapshot !== null;
  const pending = outcome.kind === "pending";

  async function submit() {
    if (!snapshot) return;
    setOutcome({ kind: "pending" });
    try {
      const res = await fetch(`/api/v1/plan-actions/${snapshot.action.id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": snapshot.key },
        body: JSON.stringify({ plan_revision: snapshot.revision, shown: snapshot.shown }),
      });
      if (res.ok) {
        onApproved();
        return;
      }
      const problem = (await res.json().catch(() => null)) as {
        error?: { details?: { reason?: string }; message?: string };
      } | null;
      const reason = problem?.error?.details?.reason;
      if (res.status === 409 && (reason === "PLAN_CHANGED" || reason === "CONTENT_CHANGED")) {
        setOutcome({ kind: "changed", reason });
        return;
      }
      setOutcome({ kind: "error", message: problem?.error?.message ?? t.plan.dialog.failed });
    } catch {
      setOutcome({ kind: "error", message: t.plan.dialog.failed });
    }
  }

  const a = snapshot?.action;
  const keys = a ? (a.kind === "payout" ? FIELD_ORDER.payout : FIELD_ORDER.convert) : [];
  const labels = t.plan.dialog.fields as Record<string, string>;
  return (
    <Modal open={open} onClose={onClose} titleId={titleId} dismissible={!pending}>
      {snapshot && a ? (
        <div className="flex max-h-[90dvh] flex-col" data-testid="plan-approve-dialog">
          <div className="flex flex-col gap-4 overflow-y-auto p-4 md:p-6">
            <div className="flex flex-col gap-1">
              <h2
                id={titleId}
                tabIndex={-1}
                className="text-xl leading-tight font-semibold outline-none"
              >
                {a.kind === "payout" ? t.plan.dialog.titlePayout : t.plan.dialog.titleConvert}
              </h2>
              <p className="text-sm text-muted-foreground">{t.plan.dialog.boundNotice}</p>
              <p className="text-xs text-muted-foreground">
                {fill(t.plan.dialog.revision, { revision: snapshot.revision })}
              </p>
            </div>
            {outcome.kind === "changed" ? (
              <p
                role="alert"
                className="rounded-md border border-border bg-status-warning-bg p-3 text-sm text-status-warning-fg"
                data-testid="plan-changed"
              >
                {outcome.reason === "PLAN_CHANGED"
                  ? t.plan.dialog.planChanged
                  : t.plan.dialog.contentChanged}
              </p>
            ) : null}
            {outcome.kind === "error" ? (
              <p
                role="alert"
                className="rounded-md border border-border bg-status-danger-bg p-3 text-sm text-status-danger-fg"
              >
                {outcome.message}
              </p>
            ) : null}
            <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,12rem)_1fr]">
              {keys.map((k) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">{labels[k] ?? k}</dt>
                  <dd className="break-words font-medium" data-field={k}>
                    {display(k, snapshot.shown[k] ?? "", snapshot.shown)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="flex flex-col-reverse gap-2 border-t border-border p-4 sm:flex-row sm:justify-end md:px-6">
            {outcome.kind === "changed" ? (
              <Button
                type="button"
                onClick={() => {
                  onRefresh();
                  onClose();
                }}
                data-testid="plan-review-new"
              >
                {t.plan.dialog.reviewNew}
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
                  {t.plan.dialog.cancel}
                </Button>
                <Button
                  type="button"
                  onClick={() => void submit()}
                  disabled={pending}
                  data-testid="plan-approve-confirm"
                >
                  {pending ? t.plan.dialog.confirming : t.plan.dialog.confirm}
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
