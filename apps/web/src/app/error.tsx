"use client";

import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/strings";

/**
 * Route error boundary (docs/design/states.md error pattern): say what happened, what is safe (nothing
 * was sent), and what to do. No stack trace; the digest is for logs only. Focus moves to the heading
 * so a screen-reader user hears the error.
 */
export default function RouteError({
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
    <section
      role="alert"
      aria-labelledby="route-error-title"
      className="flex flex-col items-start gap-3 rounded-md border border-destructive bg-card p-6 md:p-8"
    >
      <CircleAlert aria-hidden="true" className="size-6 text-destructive" />
      <h1
        id="route-error-title"
        ref={heading}
        tabIndex={-1}
        className="text-xl leading-tight font-semibold outline-none md:text-2xl"
      >
        {t.common.state.error.title}
      </h1>
      <p className="max-w-[68ch] text-muted-foreground">{t.common.state.error.body}</p>
      <div className="flex flex-wrap gap-3">
        <Button onClick={reset}>{t.common.state.retry}</Button>
        <Button asChild variant="outline">
          <Link href="/">{t.common.action.home}</Link>
        </Button>
      </div>
    </section>
  );
}
