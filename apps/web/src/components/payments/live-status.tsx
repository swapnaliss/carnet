"use client";

import { ClockAlert, RefreshCw, TriangleAlert } from "lucide-react";
import { useRecording } from "@/components/shell/recording-context";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fill, t } from "@/strings";
import { RETRYING_AFTER_FAILURES, STALE_AFTER_MS } from "./use-poll";

/**
 * LiveIndicator (docs/design/components.md): "Live · checked 3 s ago", "Retrying" after two failed
 * polls in a row, "Paused" while the tab is hidden. The dot is decorative; the text carries the
 * meaning, and it is never announced (only transitions are).
 */
export function LiveIndicator({
  lastSuccessAt,
  failures,
  paused,
  now,
}: {
  lastSuccessAt: number;
  failures: number;
  paused: boolean;
  now: number;
}) {
  const recording = useRecording();
  const seconds = Math.max(0, Math.round((now - lastSuccessAt) / 1000));
  if (recording) {
    return (
      <p
        data-testid="live-indicator"
        className="inline-flex min-h-6 items-center text-sm text-muted-foreground"
      >
        {t.replay.recordedStatus}
      </p>
    );
  }
  const retrying = failures >= RETRYING_AFTER_FAILURES;
  const text = paused
    ? t.payments.live.paused
    : retrying
      ? fill(t.payments.live.retrying, { seconds })
      : fill(t.payments.live.checked, { seconds });
  return (
    <p
      data-testid="live-indicator"
      className="inline-flex min-h-6 items-center gap-2 text-sm text-muted-foreground tabular-nums"
    >
      {retrying ? (
        <TriangleAlert aria-hidden="true" className="size-4 text-status-warning-fg" />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "size-2 rounded-full bg-status-progress-fg",
            !paused && "animate-pulse motion-reduce:animate-none",
          )}
        />
      )}
      {text}
    </p>
  );
}

/**
 * StaleBanner (docs/design/components.md): shown once the last good poll is older than 15 s. Data
 * stays on screen; "Check now" triggers an immediate fetch. Its slot is reserved so nothing shifts.
 */
export function StaleBanner({
  lastSuccessAt,
  now,
  onCheckNow,
}: {
  lastSuccessAt: number;
  now: number;
  onCheckNow: () => void;
}) {
  const recording = useRecording();
  const age = now - lastSuccessAt;
  if (recording || age <= STALE_AFTER_MS) return null;
  return (
    // Not a live region: the shell's one polite region carries announcements; this text ticks.
    <section
      aria-labelledby="stale-banner-title"
      data-testid="stale-banner"
      className="mb-6 flex flex-col gap-3 rounded-md border border-border bg-status-warning-bg p-4 text-status-warning-fg sm:flex-row sm:items-start"
    >
      <ClockAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="flex flex-1 flex-col gap-1">
        <h2 id="stale-banner-title" className="font-semibold">
          {t.common.state.stale.title}
        </h2>
        <p className="text-sm">
          {fill(t.common.state.stale.body, { seconds: Math.round(age / 1000) })}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onCheckNow}>
        <RefreshCw aria-hidden="true" />
        {t.common.state.stale.checkNow}
      </Button>
    </section>
  );
}
