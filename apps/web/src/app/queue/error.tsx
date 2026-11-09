"use client";

import { CircleAlert } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/strings";

// Section error for the queue (docs/design/screens/payment-queue.md "Error"): says what is safe, offers
// a retry, and moves focus to the heading so a screen-reader user hears it.
export default function QueueError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <>
      <h1 className="mb-6 text-xl leading-tight font-semibold md:text-2xl">{t.queue.title}</h1>
      <section
        aria-labelledby="queue-error-title"
        className="flex max-w-2xl flex-col items-start gap-3 rounded-md border border-destructive bg-card p-6 md:p-8"
      >
        <CircleAlert aria-hidden="true" className="size-6 text-destructive" />
        <h2
          id="queue-error-title"
          ref={heading}
          tabIndex={-1}
          className="text-lg leading-tight font-semibold outline-none"
        >
          {t.queue.error.load}
        </h2>
        <Button onClick={reset}>{t.common.state.retry}</Button>
      </section>
    </>
  );
}
