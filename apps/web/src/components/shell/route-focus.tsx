"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * On a client-side route change, move focus to the new page's `h1` (docs/design/accessibility.md
 * "Focus management"), so keyboard and screen-reader users start at the top of the new content.
 * The first render is left alone: a fresh page load starts at the skip link.
 */
export function RouteFocus() {
  const pathname = usePathname();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const heading = document.querySelector<HTMLElement>(`main h1`);
    if (!heading) return;
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus({ preventScroll: false });
  }, [pathname]);
  return null;
}
