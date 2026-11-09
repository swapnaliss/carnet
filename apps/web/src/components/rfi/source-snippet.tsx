"use client";

import { CircleCheck, FileText, UserCheck } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { CitationDto } from "@/server/hold";
import { fill, t } from "@/strings";

export const snippetId = (questionId: string, factVersionId: string) =>
  `snip-${questionId}-${factVersionId.replace(/[^a-zA-Z0-9]/g, "")}`;

/** The cited span marked inside the verbatim quote (the quote itself is never altered). */
function Marked({ quote, value }: { quote: string; value: string }) {
  const at = value ? quote.toLowerCase().indexOf(value.toLowerCase()) : -1;
  if (at < 0) return <>{quote}</>;
  return (
    <>
      {quote.slice(0, at)}
      <mark className="rounded-sm bg-status-warning-bg px-0.5 text-foreground underline decoration-status-warning-fg decoration-2 underline-offset-2">
        {quote.slice(at, at + value.length)}
      </mark>
      {quote.slice(at + value.length)}
    </>
  );
}

export function VerificationBadge({ verification }: { verification: CitationDto["verification"] }) {
  const Icon = verification === "quote_verified" ? CircleCheck : UserCheck;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-status-success-fg">
      <Icon aria-hidden="true" className="size-3.5" />
      {verification === "quote_verified"
        ? t.hold.citation.verified
        : t.hold.citation.ownerConfirmed}
    </span>
  );
}

/**
 * SourceSnippet (docs/design/screens/hold-screen.md): the verbatim quote from the document's text
 * layer with the cited span marked, the document, the page, the verification state and the claims
 * that cite it. The full quote is behind a disclosure when it is long.
 */
export function SourceSnippet({
  id,
  citation,
  claims,
  active,
  describedBy,
}: {
  id: string;
  citation: CitationDto;
  claims: readonly number[];
  active: boolean;
  describedBy?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = citation.quote.length > 140;
  const doc = citation.document;
  return (
    <figure
      id={id}
      aria-describedby={describedBy}
      data-testid="source-snippet"
      data-active={active ? "true" : undefined}
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border bg-background p-3",
        active && "border-primary bg-accent",
      )}
    >
      <figcaption className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="break-all">{doc.filename}</span>
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{fill(t.hold.source.page, { page: citation.page })}</span>
          <VerificationBadge verification={citation.verification} />
          {claims.length > 0 ? (
            <span>{fill(t.hold.claim.citedBy, { claims: claims.join(", ") })}</span>
          ) : null}
        </span>
      </figcaption>
      <blockquote
        id={`${id}-quote`}
        data-testid="source-quote"
        className={cn(
          "border-l-2 border-border pl-3 text-sm leading-normal break-words",
          long && !expanded && "line-clamp-3 md:line-clamp-4",
        )}
      >
        <Marked quote={citation.quote} value={citation.value} />
      </blockquote>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {long ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={`${id}-quote`}
            onClick={() => setExpanded((v) => !v)}
            className="min-h-11 rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring md:min-h-6"
          >
            {expanded ? t.hold.source.hideFullQuote : t.hold.source.showFullQuote}
          </button>
        ) : null}
        <a
          href={`/api/v1/documents/${doc.id}`}
          className="inline-flex min-h-11 items-center rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring md:min-h-6"
        >
          {t.hold.source.openDocument}
          <span className="sr-only">{fill(t.hold.source.document, { name: doc.filename })}</span>
        </a>
        <span className="font-mono">
          {fill(t.hold.source.sha, { prefix: doc.sha256.slice(0, 8) })}
        </span>
      </div>
    </figure>
  );
}
