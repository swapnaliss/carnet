"use client";

import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/strings";

// Section error for the evidence view (docs/design/screens/evidence-view.md "Error"): what is safe,
// a retry, and a way back. Focus moves to the heading so a screen-reader user hears it.
export default function EvidenceError({
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
      aria-labelledby="evidence-error-title"
      className="flex max-w-2xl flex-col items-start gap-3 rounded-md border border-destructive bg-card p-6 md:p-8"
    >
      <CircleAlert aria-hidden="true" className="size-6 text-destructive" />
      <h1
        id="evidence-error-title"
        ref={heading}
        tabIndex={-1}
        className="text-xl leading-tight font-semibold outline-none md:text-2xl"
      >
        {t.evidence.error.checks}
      </h1>
      <div className="flex flex-wrap gap-3">
        <Button onClick={reset}>{t.common.state.retry}</Button>
        <Button asChild variant="outline">
          <Link href="/queue">{t.evidence.backToQueue}</Link>
        </Button>
      </div>
    </section>
  );
}
