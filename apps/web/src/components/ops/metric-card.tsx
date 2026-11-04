import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/strings";

export type MetricVerdict = "meets" | "misses" | "warning";

const VERDICT = {
  meets: { Icon: CircleCheck, className: "bg-status-success-bg text-status-success-fg" },
  misses: { Icon: CircleX, className: "bg-status-danger-bg text-status-danger-fg" },
  warning: { Icon: CircleAlert, className: "bg-status-warning-bg text-status-warning-fg" },
} as const;

/**
 * One ops metric (docs/design/screens/ops.md, SLO tiles): name, value or "No data yet", an optional
 * verdict as icon plus text (never colour alone), its definition, window and sample size.
 */
export function MetricCard({
  id,
  title,
  value,
  definition,
  window,
  samples,
  detail,
  verdict,
}: {
  id: string;
  title: string;
  /** Null renders "No data yet", never a zero. */
  value: string | null;
  definition: string;
  window: string;
  samples?: number | undefined;
  /** A secondary line, for example the median or the last report time. */
  detail?: string | undefined;
  verdict?: { kind: MetricVerdict; label: string } | undefined;
}) {
  const v = verdict ? VERDICT[verdict.kind] : null;
  return (
    <article
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-4 md:p-5"
    >
      <h3 id={`${id}-title`} className="text-base leading-snug font-semibold">
        {title}
      </h3>
      <p className="text-xl leading-tight font-semibold tabular-nums">
        {value ?? t.ops.slo.noData}
      </p>
      {v && verdict ? (
        <p
          className={cn(
            "inline-flex w-fit items-center gap-1.5 rounded-sm px-2 py-0.5 text-sm font-medium",
            v.className,
          )}
        >
          <v.Icon aria-hidden="true" className="size-4" />
          {verdict.label}
        </p>
      ) : null}
      {detail ? <p className="text-sm text-muted-foreground tabular-nums">{detail}</p> : null}
      <p className="text-sm text-pretty">{definition}</p>
      <p className="mt-auto pt-1 text-xs text-muted-foreground tabular-nums">
        {samples === undefined ? window : `${window} · ${samples} ${t.ops.slo.samples}`}
      </p>
    </article>
  );
}

/** Milliseconds as "182 ms" or "2.4 s". */
export function formatMs(ms: number, locale: string): string {
  if (ms < 1000)
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(ms)} ms`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(ms / 1000)} s`;
}

export function formatCount(n: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(n);
}
