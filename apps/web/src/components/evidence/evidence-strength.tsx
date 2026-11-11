import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/strings";

export type Flag = "strong" | "weak" | "missing";

const FLAGS = {
  strong: { Icon: ShieldCheck, tone: "bg-status-success-bg text-status-success-fg" },
  weak: { Icon: ShieldAlert, tone: "bg-status-warning-bg text-status-warning-fg" },
  missing: { Icon: ShieldX, tone: "bg-status-danger-bg text-status-danger-fg" },
} as const;

export function flagLabel(flag: Flag): string {
  return t.evidence.strength[flag];
}

/**
 * EvidenceStrength (docs/design/components.md): `[icon] Label` in a pill. The label carries the meaning,
 * the icon and tone only reinforce it, so it is never colour alone.
 */
export function EvidenceStrength({
  flag,
  size = "sm",
  className,
}: {
  flag: Flag;
  size?: "sm" | "md";
  className?: string;
}) {
  const { Icon, tone } = FLAGS[flag];
  return (
    <span
      data-flag={flag}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border border-border font-medium whitespace-nowrap",
        size === "md" ? "min-h-7 px-2.5 text-sm" : "min-h-6 px-2 text-xs",
        tone,
        className,
      )}
    >
      <Icon aria-hidden="true" className={size === "md" ? "size-4" : "size-3.5"} />
      {flagLabel(flag)}
    </span>
  );
}
