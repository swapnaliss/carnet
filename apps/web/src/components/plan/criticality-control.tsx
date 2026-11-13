"use client";

import { useId, useState } from "react";
import { announce } from "@/components/payments/announce";
import { Button } from "@/components/ui/button";
import type { ObligationRowDto } from "@/server/plans";
import { fill, t } from "@/strings";
import { day } from "./format";

const CHOICES = [1, 2, 3] as const;

/**
 * The owner's criticality control for one obligation (ADR 0011): Carnet's proposal (value, rationale,
 * the verbatim quote and its page) sits beside the control; nothing is pre-selected; the value counts
 * only after the server confirms it. A viewer sees the control disabled. Unconfirmed obligations say
 * so, and that the planner treats them as most protective.
 */
export function CriticalityControl({
  o,
  canAct,
  onChanged,
}: {
  o: ObligationRowDto;
  canAct: boolean;
  onChanged: () => void;
}) {
  const c = o.criticality;
  const name = useId();
  const noteId = useId();
  const [choice, setChoice] = useState<1 | 2 | 3 | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!c) return null;
  const confirmed = c.confirmed_at !== null;
  const proposal = c.proposal;

  async function confirm() {
    if (choice === null || !canAct) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/obligations/${o.id}/criticality/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          criticality: choice,
          ...(proposal ? { proposal_id: proposal.id } : {}),
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setChoice(null);
      announce(fill(t.plan.criticality.saved, { payee: o.payee }));
      onChanged();
    } catch {
      setError(t.plan.criticality.failed);
    } finally {
      setPending(false);
    }
  }

  const control = (
    <fieldset
      className="flex flex-col gap-2"
      disabled={!canAct || pending}
      aria-describedby={canAct ? undefined : noteId}
    >
      <legend className="sr-only">
        {confirmed ? t.plan.criticality.change : t.plan.criticality.choose}
      </legend>
      {CHOICES.map((n) => (
        <label key={n} className="flex min-h-11 items-start gap-2 text-sm md:min-h-0">
          <input
            type="radio"
            name={name}
            value={n}
            checked={choice === n}
            onChange={() => setChoice(n)}
            className="mt-1 size-4"
          />
          <span>{t.plan.criticality.level[n]}</span>
        </label>
      ))}
      <div>
        <Button
          type="button"
          size="sm"
          disabled={choice === null || !canAct || pending}
          onClick={() => void confirm()}
          data-testid="criticality-confirm"
        >
          {pending ? t.plan.criticality.confirming : t.plan.criticality.confirmCta}
        </Button>
      </div>
    </fieldset>
  );

  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted p-3 text-sm" data-testid="criticality">
      <p className="font-medium" data-testid="criticality-status">
        {confirmed
          ? fill(t.plan.criticality.confirmedBy, {
              level: c.planning,
              who: c.confirmed_by_name ?? t.plan.criticality.someone,
              date: day(c.confirmed_at as string),
            })
          : t.plan.criticality.unconfirmed}
      </p>
      {proposal ? (
        proposal.proposed_criticality !== null ? (
          <div className="flex flex-col gap-1" data-testid="criticality-proposal">
            <p>{fill(t.plan.criticality.proposes, { level: proposal.proposed_criticality })}</p>
            <p className="text-muted-foreground">{proposal.rationale}</p>
            <blockquote className="border-l-2 border-border pl-3 italic">
              {proposal.quote}
            </blockquote>
            <p className="text-xs text-muted-foreground">
              {fill(t.plan.criticality.quotePage, { page: proposal.quote_page ?? 0 })}
            </p>
          </div>
        ) : (
          <p className="text-muted-foreground" data-testid="criticality-proposal">
            {proposal.message ?? t.plan.criticality.noProposal}
          </p>
        )
      ) : (
        <p className="text-muted-foreground">{t.plan.criticality.noProposal}</p>
      )}
      <details>
        <summary className="min-h-11 cursor-pointer py-2 font-medium md:min-h-0">
          {confirmed ? t.plan.criticality.change : t.plan.criticality.choose}
        </summary>
        {control}
      </details>
      {canAct ? null : (
        <p id={noteId} className="text-muted-foreground">
          {t.plan.criticality.viewerNote}
        </p>
      )}
      {error ? (
        <p role="alert" className="text-status-danger-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
