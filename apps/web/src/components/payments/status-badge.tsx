import {
  Ban,
  CalendarClock,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleSlash,
  LoaderCircle,
  type LucideIcon,
  OctagonX,
  Send,
  TriangleAlert,
  Undo2,
  UserCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { StatusDescription, StatusIcon, Tone } from "./format";

const ICONS: Record<StatusIcon, LucideIcon> = {
  none: CircleDashed,
  approval: UserCheck,
  undo: Undo2,
  octagon: OctagonX,
  ban: Ban,
  calendar: CalendarClock,
  alert: TriangleAlert,
  // Static (never spinning): docs/design/components.md
  loader: LoaderCircle,
  send: Send,
  check: CircleCheck,
  slash: CircleSlash,
  help: CircleHelp,
};

const TONES: Record<Tone, string> = {
  neutral: "bg-status-neutral-bg text-status-neutral-fg",
  progress: "bg-status-progress-bg text-status-progress-fg",
  success: "bg-status-success-bg text-status-success-fg",
  warning: "bg-status-warning-bg text-status-warning-fg",
  danger: "bg-status-danger-bg text-status-danger-fg",
  held: "bg-status-held-bg text-status-held-fg",
};

/**
 * StatusBadge (docs/design/components.md): `[icon] Label` in a pill, tone by status, never colour
 * alone (the label carries the meaning). The hint is visible text where `showHint` is set, otherwise
 * part of the accessible description.
 */
export function StatusBadge({
  status,
  size = "sm",
  showHint = false,
  className,
}: {
  status: StatusDescription;
  size?: "sm" | "md";
  showHint?: boolean;
  className?: string;
}) {
  const Icon = ICONS[status.icon];
  return (
    <span className={cn("inline-flex flex-col items-start gap-1", className)}>
      <span
        data-status={status.key}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-sm border border-border font-medium whitespace-nowrap",
          size === "md" ? "min-h-7 px-2.5 text-sm" : "min-h-6 px-2 text-xs",
          TONES[status.tone],
        )}
      >
        <Icon aria-hidden="true" className={size === "md" ? "size-4" : "size-3.5"} />
        {status.label}
        {showHint ? null : <span className="sr-only">{`. ${status.hint}`}</span>}
      </span>
      {showHint ? <span className="text-sm text-muted-foreground">{status.hint}</span> : null}
    </span>
  );
}
