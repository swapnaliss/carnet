"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/** How long a route change waits for its page `h1` while a loading.tsx skeleton is on screen. */
const WAIT_MS = 10_000;

/**
 * On a client-side route change, move focus to the new page's `h1` (docs/design/accessibility.md
 * "Focus management"), so keyboard and screen-reader users start at the top of the new content.
 * The first render is left alone: a fresh page load starts at the skip link.
 *
 * A route with a loading.tsx changes the pathname while its skeleton (no `h1`) is shown; the page
 * streams in later. The effect then waits for the `h1` and focuses it, unless the person has already
 * moved focus somewhere else on the new page (no focus theft, M4-07).
 */
export function RouteFocus() {
  const pathname = usePathname();
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect must re-run on each route change
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const before = document.activeElement;
    const focusHeading = (): boolean => {
      const heading = document.querySelector<HTMLElement>("main h1");
      if (!heading) return false;
      const now = document.activeElement;
      const untouched =
        !now || now === document.body || now === before || !now.isConnected || !now.closest("main");
      if (!untouched) return true;
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.focus({ preventScroll: false });
      return true;
    };
    if (focusHeading()) return;
    const main = document.querySelector("main");
    if (!main) return;
    const observer = new MutationObserver(() => {
      if (focusHeading()) stop();
    });
    const timer = window.setTimeout(() => stop(), WAIT_MS);
    function stop() {
      observer.disconnect();
      window.clearTimeout(timer);
    }
    observer.observe(main, { childList: true, subtree: true });
    return stop;
  }, [pathname]);
  return null;
}
