"use client";

import { CircleAlert, Copy } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/strings";

/**
 * Page-level error (docs/design/states.md "Error", level 3), rendered inside the shell: what happened,
 * what is safe (nothing was sent), Retry and "Go to the queue", and the correlation id (Next's error
 * digest, which matches the server log line) in mono with Copy. Never a stack trace. Focus moves to
 * the heading so a screen-reader user hears the error.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  const copy = async () => {
    if (!error.digest) return;
    try {
      await navigator.clipboard.writeText(error.digest);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section
      aria-labelledby="route-error-title"
      className="flex max-w-2xl flex-col items-start gap-3 rounded-md border border-destructive bg-card p-6 md:p-8"
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
      <p className="max-w-[65ch] text-pretty text-muted-foreground">{t.common.state.error.body}</p>
      <div className="flex flex-wrap gap-3">
        <Button onClick={reset}>{t.common.state.retry}</Button>
        <Button asChild variant="outline">
          <Link href="/queue">{t.common.action.queue}</Link>
        </Button>
      </div>
      {error.digest ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{t.common.state.error.correlationId}</span>
          <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-foreground">
            {error.digest}
          </code>
          <Button variant="ghost" size="sm" onClick={copy}>
            <Copy aria-hidden="true" />
            {copied ? t.common.action.copied : t.common.action.copy}
          </Button>
          <span role="status" className="sr-only">
            {copied ? t.common.action.copied : null}
          </span>
        </div>
      ) : null}
    </section>
  );
}
