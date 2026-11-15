"use client";

import { ExternalLink, Pause, Play, RotateCcw, SkipBack, SkipForward } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { RecordingView } from "@/server/replay/recording";
import { fill, t } from "@/strings";

/** One step every 2.5 s while playing; reduced motion does not change it (no animation is involved). */
const PLAY_INTERVAL_MS = 2_500;

/**
 * The recording's timeline (docs/design/screens/replay.md): play, pause, previous, next, restart; the
 * current step's detail with its source file and a link to the screen that shows it; then the whole
 * ordered list, where any step can be chosen. Keyboard: every control is a button; arrow keys on the
 * list move the current step. The step change is announced politely.
 */
export function ReplayTimeline({ recording }: { recording: RecordingView }) {
  const total = recording.events.length;
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const titleId = useId();
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!playing) return;
    if (index >= total - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setIndex((i) => Math.min(i + 1, total - 1)), PLAY_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [playing, index, total]);

  const current = recording.events[index];
  const go = (i: number) => setIndex(Math.max(0, Math.min(total - 1, i)));

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-4"
      data-recording={recording.id}
    >
      <header className="flex flex-col gap-1">
        <h2 id={titleId} className="text-lg leading-tight font-semibold">
          {recording.label}
        </h2>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <div className="flex gap-1">
            <dt>{t.replay.page.capturedOn}:</dt>
            <dd data-testid="captured-on">{recording.capturedOn ?? "—"}</dd>
          </div>
          <div className="flex gap-1">
            <dt>{t.replay.page.commit}:</dt>
            <dd className="font-mono" data-testid="deployed-version">
              {recording.deployedVersion ?? "—"}
            </dd>
          </div>
          <div className="flex gap-1">
            <dt>{t.replay.page.models}:</dt>
            <dd className="font-mono" data-testid="models">
              {recording.models.join(", ") || "—"}
            </dd>
          </div>
        </dl>
        {!recording.materialized ? (
          <p className="text-sm text-muted-foreground">{t.replay.page.notMaterialized}</p>
        ) : null}
      </header>

      {total === 0 || !current ? (
        <p className="text-muted-foreground">{t.replay.page.emptyBody}</p>
      ) : (
        <>
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">{t.replay.page.controls}</legend>
            {playing ? (
              <Button type="button" onClick={() => setPlaying(false)} data-testid="replay-pause">
                <Pause aria-hidden="true" />
                {t.replay.page.pause}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={() => {
                  if (index >= total - 1) setIndex(0);
                  setPlaying(true);
                }}
                data-testid="replay-play"
              >
                <Play aria-hidden="true" />
                {t.replay.page.play}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => go(index - 1)}
              disabled={index === 0}
              data-testid="replay-previous"
            >
              <SkipBack aria-hidden="true" />
              {t.replay.page.previous}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => go(index + 1)}
              disabled={index >= total - 1}
              data-testid="replay-next"
            >
              <SkipForward aria-hidden="true" />
              {t.replay.page.next}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setPlaying(false);
                setIndex(0);
              }}
              data-testid="replay-restart"
            >
              <RotateCcw aria-hidden="true" />
              {t.replay.page.restart}
            </Button>
          </fieldset>

          <article
            aria-live="polite"
            aria-atomic="true"
            data-testid="replay-current"
            className="flex flex-col gap-2 rounded-md border border-border bg-card p-4 md:p-6"
          >
            <p className="text-sm text-muted-foreground">
              {fill(t.replay.page.step, { n: index + 1, total })} ·{" "}
              <time dateTime={current.at}>{current.at}</time>
            </p>
            <h3 className="text-base font-semibold">{current.title}</h3>
            {current.detail ? <p className="break-words">{current.detail}</p> : null}
            <p className="text-sm text-muted-foreground break-all">
              {t.replay.page.source}: <span className="font-mono">{current.source}</span>
            </p>
            {current.href ? (
              <Link
                href={current.href}
                className="inline-flex min-h-11 items-center gap-1.5 self-start underline underline-offset-4 md:min-h-0"
                data-testid="replay-open-screen"
              >
                {t.replay.page.openScreen}
                <ExternalLink aria-hidden="true" className="size-4" />
              </Link>
            ) : null}
          </article>

          <h3 className="text-base font-semibold">{t.replay.page.timeline}</h3>
          <ol ref={listRef} className="flex flex-col gap-1" data-testid="replay-list">
            {recording.events.map((e, i) => (
              <li key={`${e.at}|${e.kind}|${e.source}|${e.title}`}>
                <button
                  type="button"
                  aria-current={i === index ? "step" : undefined}
                  onClick={() => {
                    setPlaying(false);
                    setIndex(i);
                  }}
                  onKeyDown={(ev) => {
                    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
                    ev.preventDefault();
                    const next = Math.max(
                      0,
                      Math.min(total - 1, i + (ev.key === "ArrowDown" ? 1 : -1)),
                    );
                    setIndex(next);
                    listRef.current?.querySelectorAll("button")[next]?.focus();
                  }}
                  className={`flex min-h-11 w-full flex-col items-start gap-0.5 rounded-sm border px-3 py-2 text-start text-sm md:flex-row md:items-baseline md:gap-3 ${
                    i === index
                      ? "border-primary bg-accent text-accent-foreground"
                      : "border-transparent hover:bg-accent"
                  }`}
                >
                  <span className="font-mono text-xs text-muted-foreground md:w-52 md:shrink-0">
                    {e.at}
                  </span>
                  <span>{e.title}</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
