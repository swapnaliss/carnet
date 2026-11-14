"use client";

import {
  Activity,
  Banknote,
  CalendarRange,
  Inbox,
  ListChecks,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { t } from "@/strings";

const items: ReadonlyArray<{ href: string; label: string; icon: LucideIcon; match?: string }> = [
  { href: "/queue", label: t.shell.nav.queue, icon: ListChecks },
  // M1-08: the walking-skeleton payments (create, live status). M2-03 folds them into the queue.
  { href: "/payments", label: t.shell.nav.payments, icon: Banknote },
  { href: "/rfis", label: t.shell.nav.rfis, icon: Inbox },
  { href: "/plan", match: "/plans", label: t.shell.nav.plan, icon: CalendarRange },
  { href: "/ops", label: t.shell.nav.ops, icon: Activity },
];

/**
 * Main navigation (docs/design/components.md AppShell): a bottom tab bar below 768px, a 64px icon rail
 * with visible labels at 768px, and a 216px sidebar from 1280px. The current page carries
 * `aria-current="page"`, the accent fill and a 3px rule, so it is never marked by colour alone.
 */
export function MainNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label={t.shell.nav.label}
      className={cn(
        "fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]",
        "md:sticky md:top-(--shell-header-height) md:inset-x-auto md:bottom-auto md:h-[calc(100dvh-var(--shell-header-height))] md:w-16 md:shrink-0 md:border-t-0 md:border-r md:pb-0",
        "xl:w-(--shell-nav-width)",
      )}
    >
      <ul className="flex md:flex-col md:gap-1 md:py-3 xl:px-3">
        {items.map(({ href, label, icon: Icon, match }) => {
          const base = match ?? href;
          const current = pathname === href || pathname === base || pathname.startsWith(`${base}/`);
          return (
            <li key={href} className="flex-1 md:flex-none">
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "relative flex min-h-14 flex-col focus-visible:outline-offset-[-2px] items-center justify-center gap-1 px-2 text-xs font-medium text-muted-foreground",
                  "transition-colors duration-(--duration-fast) hover:bg-accent hover:text-accent-foreground",
                  "md:min-h-16 xl:min-h-10 xl:flex-row xl:justify-start xl:gap-3 xl:rounded-md xl:px-3 xl:text-sm",
                  current &&
                    "bg-accent text-accent-foreground before:absolute before:inset-x-3 before:top-0 before:h-[3px] before:rounded-b-sm before:bg-primary md:before:inset-x-auto md:before:inset-y-3 md:before:left-0 md:before:h-auto md:before:w-[3px] md:before:rounded-r-sm md:before:rounded-b-none",
                )}
              >
                <Icon aria-hidden="true" className="size-5 shrink-0" />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
