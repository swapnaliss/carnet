"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * A modal dialog on the native `<dialog>` element: the browser traps focus inside it, makes the rest
 * of the page inert, closes on Esc and returns focus to the control that opened it. `dismissible`
 * false ignores Esc and the backdrop (an approval is being submitted). Focus starts on the title.
 */
export function Modal({
  open,
  onClose,
  titleId,
  dismissible = true,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  titleId: string;
  dismissible?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      document.getElementById(titleId)?.focus();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open, titleId]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
      className={cn(
        "m-auto max-h-[90dvh] w-[min(40rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-border bg-card p-0 text-card-foreground shadow-3 backdrop:bg-black/50",
        className,
      )}
    >
      {open ? children : null}
    </dialog>
  );
}
