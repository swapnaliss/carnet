"use client";

import { OctagonX, RefreshCcw } from "lucide-react";
import type { HoldView } from "@/server/hold";
import { fill, t } from "@/strings";
import { blockingQuestions, followUpCounts } from "./view";

/**
 * Follow-up round (M3-05), shown from round 2 on: what Airwallex reopened, how many answers are reused,
 * why a question blocks the whole request, and "Apply all reused answers". The button is one approval
 * over exactly the answers on screen (the same request the approval dialog sends, built from the same
 * view); it is only offered when every answer is a reused one, since anything new is read in the dialog.
 * Nothing is recorded as applied until the server says so (ADR 0017: no optimistic updates).
 */
export function FollowUpPanel({
  view,
  error,
  onGoto,
}: {
  view: HoldView;
  /** The message of a failed "Apply all reused answers" (the action itself lives in the approval bar). */
  error: string | null;
  onGoto: (position: number) => void;
}) {
  if (view.rfi.round < 2) return null;

  const counts = followUpCounts(view);
  const blocked = blockingQuestions(view);

  return (
    <section
      aria-labelledby="follow-up-heading"
      data-testid="follow-up-panel"
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
    >
      <div className="flex items-start gap-3">
        <RefreshCcw aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="follow-up-heading" className="text-lg leading-tight font-semibold">
            {t.hold.followUp.heading}
          </h2>
          <p className="text-sm text-muted-foreground" data-testid="follow-up-summary">
            {fill(t.hold.followUp.summary, { round: view.rfi.round, ...counts })}
          </p>
        </div>
      </div>

      {blocked.length > 0 ? (
        <div
          role="alert"
          data-testid="follow-up-blocked"
          className="flex gap-3 rounded-md border border-border bg-status-warning-bg p-3 text-sm text-status-warning-fg"
        >
          <OctagonX aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div className="flex flex-col gap-1">
            <p className="font-semibold">{t.hold.followUp.blockedTitle}</p>
            <p>{t.hold.followUp.blockedBody}</p>
            <ul className="list-disc pl-5">
              {blocked.map((b) => (
                <li key={b.position}>
                  <button
                    type="button"
                    onClick={() => onGoto(b.position - 1)}
                    className="min-h-11 rounded-sm text-left font-medium underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring md:min-h-6"
                  >
                    {fill(t.hold.followUp.blockedItem, { position: b.position, title: b.title })}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {error ? (
        <p
          role="alert"
          data-testid="follow-up-error"
          className="rounded-md bg-status-danger-bg p-3 text-sm text-status-danger-fg"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}
