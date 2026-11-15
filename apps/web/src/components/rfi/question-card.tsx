"use client";

import {
  CircleCheck,
  CircleDashed,
  FileText,
  LoaderCircle,
  TriangleAlert,
  UserPen,
} from "lucide-react";
import dynamic from "next/dynamic";
import { memo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CitationDto, HoldView, QuestionDto } from "@/server/hold";
import { fill, t } from "@/strings";
import type { EditMode } from "./edit-answer";
import { SourceSnippet, snippetId } from "./source-snippet";
import {
  claimsOf,
  type FollowUpBadge,
  followUpBadge,
  formatBytes,
  needsOwnerKey,
  type QuestionStatus,
  questionStatus,
  snippetGroups,
} from "./view";

// The answer editor loads when the owner opens it, not with the first paint (INP, M4-07).
const EditAnswer = dynamic(() => import("./edit-answer").then((m) => m.EditAnswer), {
  ssr: false,
});

const STATUS_STYLE: Record<QuestionStatus, string> = {
  ready: "bg-status-success-bg text-status-success-fg",
  needs_owner: "bg-status-warning-bg text-status-warning-fg",
  yours: "bg-status-progress-bg text-status-progress-fg",
  drafting: "bg-status-neutral-bg text-status-neutral-fg",
};

export function QuestionStatusChip({
  status,
  edited,
  sent = false,
}: {
  status: QuestionStatus;
  edited: boolean;
  sent?: boolean;
}) {
  const label = sent
    ? t.hold.question.statusSent
    : status === "ready"
      ? edited
        ? t.hold.question.statusEdited
        : t.hold.question.statusReady
      : status === "yours"
        ? t.hold.question.statusYours
        : status === "needs_owner"
          ? t.hold.question.statusNeedsOwner
          : t.hold.question.statusDrafting;
  const Icon =
    status === "ready"
      ? CircleCheck
      : status === "yours"
        ? UserPen
        : status === "needs_owner"
          ? TriangleAlert
          : CircleDashed;
  return (
    <span
      data-testid="question-status"
      data-status={status}
      className={cn(
        "inline-flex min-h-6 items-center gap-1.5 rounded-sm border border-border px-2 text-xs font-medium whitespace-nowrap",
        STATUS_STYLE[status],
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {label}
    </span>
  );
}

const BADGE_STYLE: Record<FollowUpBadge, string> = {
  reused: "bg-status-success-bg text-status-success-fg",
  new_draft: "bg-status-progress-bg text-status-progress-fg",
  needs_you: "bg-status-warning-bg text-status-warning-fg",
};

/** Round 2 and later: where this question's answer came from (never colour alone: the label says it). */
function FollowUpChip({ badge }: { badge: FollowUpBadge }) {
  const label =
    badge === "reused"
      ? t.hold.followUp.badgeReused
      : badge === "new_draft"
        ? t.hold.followUp.badgeNew
        : t.hold.followUp.badgeNeeds;
  return (
    <span
      data-testid="follow-up-badge"
      data-badge={badge}
      className={cn(
        "inline-flex min-h-6 items-center rounded-sm border border-border px-2 text-xs font-medium whitespace-nowrap",
        BADGE_STYLE[badge],
      )}
    >
      {label}
    </span>
  );
}

const formatDay = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso));

function Chip({
  citation,
  snippet,
  onSelect,
}: {
  citation: CitationDto;
  snippet: string;
  onSelect: () => void;
}) {
  const state =
    citation.verification === "quote_verified"
      ? t.hold.citation.verified
      : t.hold.citation.ownerConfirmed;
  return (
    <button
      type="button"
      aria-controls={snippet}
      onClick={onSelect}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-sm border border-border bg-background px-2 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-focus-ring md:min-h-6"
    >
      <FileText aria-hidden="true" className="size-3.5 text-muted-foreground" />
      <span className="sr-only">{t.hold.citation.prefix}</span>
      <span className="max-w-40 truncate">{citation.document.filename}</span>
      <span>{fill(t.hold.source.page, { page: citation.page })}</span>
      <span className="sr-only">{state}</span>
      <CircleCheck aria-hidden="true" className="size-3.5 text-status-success-fg" />
    </button>
  );
}

function QuestionCardImpl({
  view,
  question,
  position,
  total,
  selected,
  activeSnippet,
  onSnippet,
  canEdit,
  lockedReason,
  onChanged,
}: {
  view: HoldView;
  question: QuestionDto;
  position: number;
  total: number;
  selected: boolean;
  activeSnippet: string | null;
  onSnippet: (id: string) => void;
  canEdit: boolean;
  lockedReason: string | null;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<EditMode | null>(null);
  const status = questionStatus(question, view.rfi.state);
  const answer = question.answer;
  const attachment = question.answer_type === "ATTACHMENT";
  const ownerDraft = view.draft?.origin === "owner";
  const claims = answer && status !== "needs_owner" ? claimsOf(answer) : [];
  const groups = answer && status !== "needs_owner" ? snippetGroups(claims, answer) : [];
  const titleId = `q-${question.id}-title`;
  // Closing the editor removes the focused control; focus returns to this question's heading so a
  // keyboard user keeps their place (M4-07).
  const returnFocus = () =>
    window.requestAnimationFrame(() => document.getElementById(titleId)?.focus());
  const rejectedText = status === "needs_owner" && answer && answer.text !== "";
  const reasonKey = needsOwnerKey(answer?.reason_code ?? null);
  const qid = question.id;
  const badge = followUpBadge(question, view.rfi.state);
  const changed = question.follow_up?.kind === "changed" ? question.follow_up.previous : null;

  return (
    <li
      id={`q-${question.id}`}
      data-testid="question"
      data-question-position={position}
      aria-labelledby={titleId}
      className={cn(
        "grid scroll-mt-24 gap-x-6 gap-y-4 rounded-md border bg-card p-4 md:p-6 md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]",
        selected ? "border-primary" : "border-border",
      )}
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 id={titleId} tabIndex={-1} className="text-lg leading-tight font-semibold">
            {fill(t.hold.question.position, {
              position,
              total,
              title: question.title,
            })}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {badge && badge !== "needs_you" ? <FollowUpChip badge={badge} /> : null}
            <QuestionStatusChip
              status={status}
              edited={ownerDraft && status === "ready"}
              sent={view.rfi.state === "ANSWERED" || view.rfi.state === "CLOSED"}
            />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {question.description}
          {attachment ? (
            <span className="ml-2 inline-flex rounded-sm border border-border px-1.5 text-xs">
              {t.hold.question.answerTypeAttachment}
            </span>
          ) : null}
          {question.reopened ? (
            <span className="ml-2 inline-flex rounded-sm border border-border px-1.5 text-xs">
              {t.hold.question.reopened}
            </span>
          ) : null}
        </p>

        {changed ? (
          <section
            aria-label={t.hold.followUp.changedTitle}
            data-testid="question-diff"
            className="flex flex-col gap-1 rounded-md border border-border bg-status-progress-bg p-3 text-sm text-status-progress-fg"
          >
            <p className="font-semibold">{t.hold.followUp.changedTitle}</p>
            <p>
              <span className="font-medium">{t.hold.followUp.earlier} </span>
              <del data-testid="diff-old">
                {[changed.title, changed.description].filter(Boolean).join(" - ")}
              </del>
            </p>
            <p>
              <span className="font-medium">{t.hold.followUp.now} </span>
              <ins data-testid="diff-new" className="no-underline">
                {[question.title, question.description].filter(Boolean).join(" - ")}
              </ins>
            </p>
          </section>
        ) : null}

        {answer?.reuse && status !== "needs_owner" ? (
          <p
            data-testid="same-as-approved"
            className="rounded-md bg-status-success-bg p-2 text-sm text-status-success-fg"
          >
            <span className="font-semibold">
              {fill(t.hold.followUp.sameAs, { date: formatDay(answer.reuse.approved_on) })}
            </span>
            <span className="block">{t.hold.followUp.sameAsHint}</span>
          </p>
        ) : null}

        {status === "drafting" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle aria-hidden="true" className="size-4" />
            {t.hold.question.drafting}
          </p>
        ) : null}

        {status === "needs_owner" ? (
          <section
            aria-label={t.hold.needsOwner.heading}
            data-testid="needs-owner"
            className="flex flex-col gap-2 rounded-md border border-border bg-status-warning-bg p-3 text-status-warning-fg"
          >
            <p className="font-semibold">{t.hold.needsOwner.heading}</p>
            <p className="text-sm" data-testid="needs-owner-reason">
              {t.hold.needsOwner[reasonKey]}
            </p>
            {answer?.explanation && reasonKey === "verifierRejected" ? (
              <p className="text-sm">{answer.explanation}</p>
            ) : null}
            <p className="text-sm">{t.hold.needsOwner.blocksRfi}</p>
            {rejectedText ? (
              <p className="rounded-sm bg-card p-2 text-sm text-foreground">
                <span className="font-medium">{t.hold.edit.rejectedTitle}</span>
                <span className="block break-words">{answer.text}</span>
              </p>
            ) : null}
            <p className="text-sm font-medium">{t.hold.needsOwner.doNext}</p>
            <ul className="list-disc pl-5 text-sm">
              <li>{attachment ? t.hold.needsOwner.attach : t.hold.needsOwner.write}</li>
              <li>{t.hold.needsOwner.confirm}</li>
            </ul>
          </section>
        ) : null}

        {(status === "ready" || status === "yours") && answer && !attachment ? (
          <ol aria-label={t.hold.claim.list} className="flex flex-col gap-2">
            {claims.map((c) => (
              <li key={`${c.n}:${c.text}`} data-testid="claim" className="flex items-start gap-3">
                {c.n > 0 ? (
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
                  >
                    {c.n}
                  </span>
                ) : (
                  <span aria-hidden="true" className="size-6 shrink-0" />
                )}
                <div className="flex min-w-0 flex-col gap-1">
                  {c.n > 0 ? (
                    <span className="sr-only">{fill(t.hold.claim.label, { n: c.n })}</span>
                  ) : null}
                  <p className="break-words">{c.text}</p>
                  {c.citations.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {c.citations.map((cit) => (
                        <Chip
                          key={cit.fact_version_id}
                          citation={cit}
                          snippet={snippetId(qid, cit.fact_version_id)}
                          onSelect={() => {
                            const target = snippetId(qid, cit.fact_version_id);
                            onSnippet(target);
                            document.getElementById(target)?.scrollIntoView({ block: "nearest" });
                          }}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        ) : null}

        {status === "yours" && answer ? (
          <p className="text-sm text-status-progress-fg">{t.hold.claim.yourStatement}</p>
        ) : null}

        {(status === "ready" || status === "yours") && attachment && answer ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{t.hold.attachments.heading}</p>
            <ul className="flex flex-col gap-1">
              {answer.documents.map((d) => (
                <li key={d.id} className="flex items-start gap-2 text-sm" data-testid="attachment">
                  <FileText
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="break-all font-medium">{d.filename}</span>
                    <span className="text-xs text-muted-foreground">
                      {fill(t.hold.attachments.file, {
                        name: d.kind,
                        kind: d.mime,
                        size: formatBytes(d.size),
                        prefix: d.sha256.slice(0, 8),
                      })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {answer && answer.unresolved_citations.length > 0 ? (
          <p role="alert" className="text-sm text-status-danger-fg">
            {t.hold.source.failed}
          </p>
        ) : null}

        {canEdit && mode === null ? (
          <div className="flex flex-wrap gap-2">
            {status === "ready" && !attachment ? (
              <Button variant="outline" onClick={() => setMode("edit")}>
                {t.hold.edit.cta}
              </Button>
            ) : null}
            {status === "yours" && !attachment ? (
              <Button variant="outline" onClick={() => setMode("write")}>
                {t.hold.edit.cta}
              </Button>
            ) : null}
            {status === "needs_owner" && !attachment && rejectedText ? (
              <Button variant="outline" onClick={() => setMode("edit")}>
                {t.hold.edit.cta}
              </Button>
            ) : null}
            {status === "needs_owner" && !attachment && !rejectedText ? (
              <Button variant="secondary" onClick={() => setMode("write")}>
                {t.hold.answer.write}
              </Button>
            ) : null}
            {attachment && (status === "needs_owner" || status === "ready") ? (
              <Button variant="secondary" onClick={() => setMode("attach")}>
                {t.hold.answer.attach}
              </Button>
            ) : null}
          </div>
        ) : null}
        {!canEdit && lockedReason && status !== "drafting" ? (
          <p className="text-xs text-muted-foreground">{lockedReason}</p>
        ) : null}

        {mode !== null ? (
          <EditAnswer
            view={view}
            question={question}
            mode={mode}
            onCancel={() => {
              setMode(null);
              returnFocus();
            }}
            onDone={() => {
              setMode(null);
              onChanged();
              returnFocus();
            }}
          />
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-3" data-testid="sources">
        {groups.length > 0 ? (
          groups.map((g) => (
            <SourceSnippet
              key={g.citation.fact_version_id}
              id={snippetId(qid, g.citation.fact_version_id)}
              citation={g.citation}
              claims={g.claims}
              active={activeSnippet === snippetId(qid, g.citation.fact_version_id)}
            />
          ))
        ) : status === "needs_owner" ? (
          <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
            {t.hold.source.none}
            <br />
            {t.hold.source.none2}
          </p>
        ) : null}
      </div>
    </li>
  );
}

type QuestionCardProps = Parameters<typeof QuestionCardImpl>[0];

/**
 * A poll response carries a new `server_time` every 3 s; the card never reads it. With the poll's
 * structural sharing (use-poll.ts `share`) every other part of an unchanged view keeps its identity, so
 * the card skips re-rendering unless something it shows changed (INP on mid-tier phones, M4-07).
 */
function sameProps(a: QuestionCardProps, b: QuestionCardProps): boolean {
  for (const k of Object.keys(b) as (keyof QuestionCardProps)[]) {
    if (k === "view") continue;
    if (a[k] !== b[k]) return false;
  }
  if (a.view === b.view) return true;
  const va = a.view as unknown as Record<string, unknown>;
  const vb = b.view as unknown as Record<string, unknown>;
  const keys = Object.keys(vb);
  if (keys.length !== Object.keys(va).length) return false;
  return keys.every((k) => k === "server_time" || va[k] === vb[k]);
}

export const QuestionCard = memo(QuestionCardImpl, sameProps);
