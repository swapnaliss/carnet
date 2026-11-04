import { FlaskConical } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { t } from "@/strings";
import { MainNav } from "./main-nav";
import { RouteFocus } from "./route-focus";

/**
 * The app shell (docs/design/components.md AppShell): skip link, 56px header with the wordmark and the
 * always-visible Sandbox pill, main navigation, and `<main id="main" tabindex="-1">` as the skip
 * target. Business name, user menu and the held-count pill join the header once a session exists.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <a
        href="#main"
        className="fixed inset-x-0 top-0 z-50 flex h-(--shell-header-height) -translate-y-full items-center bg-primary px-4 text-sm font-medium text-primary-foreground underline underline-offset-4 focus:translate-y-0 focus:shadow-3 focus-visible:outline-offset-[-4px] focus-visible:outline-primary-foreground md:px-6"
      >
        {t.shell.skipLink}
      </a>
      <header className="sticky top-0 z-30 flex h-(--shell-header-height) items-center gap-3 border-b border-border bg-card px-4 md:px-6">
        <Link
          href="/"
          aria-label={t.shell.header.home}
          className="flex min-h-11 items-center rounded-sm text-lg font-semibold tracking-tight text-foreground md:min-h-9"
        >
          {t.app.name}
        </Link>
        <span className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-status-neutral-bg px-2 py-0.5 text-xs font-medium text-status-neutral-fg">
          <FlaskConical aria-hidden="true" className="size-3.5" />
          {t.shell.header.sandbox} <span className="sr-only">{t.shell.header.sandboxHint}</span>
        </span>
      </header>
      <div className="flex min-h-[calc(100dvh-var(--shell-header-height))]">
        <MainNav />
        <main
          id="main"
          tabIndex={-1}
          className="min-w-0 flex-1 px-4 pt-6 pb-24 outline-none md:px-8 md:pt-8 md:pb-12"
        >
          <div className="mx-auto w-full max-w-(--content-max)">{children}</div>
        </main>
      </div>
      {/* The one polite live region per page (docs/design/accessibility.md "Live regions"). */}
      <div
        id="live-region"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />
      <RouteFocus />
    </>
  );
}
