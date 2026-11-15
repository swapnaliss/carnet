"use client";

import { CircleAlert } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/strings";

// Error state for the recording (docs/design/screens/replay.md): nothing live is affected; a retry,
// and focus on the heading so a screen-reader user hears it.
export default function ReplayError({
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
      <h1 className="mb-6 text-xl leading-tight font-semibold md:text-2xl">
        {t.replay.page.title}
      </h1>
      <section
        aria-labelledby="replay-error-title"
        className="flex max-w-2xl flex-col items-start gap-3 rounded-md border border-destructive bg-card p-6 md:p-8"
      >
        <CircleAlert aria-hidden="true" className="size-6 text-destructive" />
        <h2
          id="replay-error-title"
          ref={heading}
          tabIndex={-1}
          className="text-lg leading-tight font-semibold outline-none"
        >
          {t.replay.page.errorTitle}
        </h2>
        <p className="text-muted-foreground">{t.replay.page.errorBody}</p>
        <Button onClick={reset}>{t.replay.page.retry}</Button>
      </section>
    </>
  );
}
