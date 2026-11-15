"use client";

// Polling for screens that wait for an Airwallex event (ADR 0017: every 3 s). Keeps the last good data
// on screen (never blanks it), counts consecutive failures, pauses while the tab is hidden and
// fetches immediately when it is shown again. No optimistic state: `data` only ever holds a server
// response.
import { useCallback, useEffect, useRef, useState } from "react";

export const POLL_MS = 3_000;
/** The ticket's freshness budget: a StaleBanner once the last good poll is older than this. */
export const STALE_AFTER_MS = 15_000;

/**
 * When a screen counts as stale for a poll that runs every `intervalMs`: the freshness budget, but
 * never before two polls had the chance to land (a 30 s poll must not look stale at 15 s).
 */
export function staleAfterMs(intervalMs: number): number {
  return Math.max(STALE_AFTER_MS, 2 * intervalMs);
}
/** Two failed polls in a row turn the LiveIndicator to "Retrying" (docs/design/components.md). */
export const RETRYING_AFTER_FAILURES = 2;

export interface PollState<T> {
  readonly data: T;
  /** `Date.now()` of the last successful response (the server render counts as the first). */
  readonly lastSuccessAt: number;
  readonly failures: number;
  readonly paused: boolean;
  readonly checkNow: () => void;
}

export interface PollOptions {
  /** False stops the timer (an RFI that reached a final state); `checkNow` still fetches. Default true. */
  readonly enabled?: boolean;
  /** Lengthen the wait after consecutive failures (jittered, at most 6x). Default false. */
  readonly backoff?: boolean;
}

export function usePoll<T>(
  url: string,
  initial: T,
  intervalMs = POLL_MS,
  options: PollOptions = {},
): PollState<T> {
  const { enabled = true, backoff = false } = options;
  const failuresRef = useRef(0);
  const [data, setData] = useState(initial);
  const [lastSuccessAt, setLastSuccessAt] = useState(() => Date.now());
  const [failures, setFailures] = useState(0);
  const [paused, setPaused] = useState(false);
  const trigger = useRef<() => void>(() => undefined);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;

    const schedule = () => {
      clearTimeout(timer);
      if (stopped || !enabled) return;
      const factor = backoff ? Math.min(6, 2 ** failuresRef.current) : 1;
      const jitter = backoff && failuresRef.current > 0 ? 0.8 + Math.random() * 0.4 : 1;
      timer = setTimeout(run, intervalMs * factor * jitter);
    };
    async function run() {
      if (stopped) return;
      if (document.visibilityState === "hidden") {
        setPaused(true);
        return; // resumes on visibilitychange
      }
      controller?.abort();
      controller = new AbortController();
      try {
        const res = await fetch(url, {
          cache: "no-store",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`poll failed with ${res.status}`);
        const next = (await res.json()) as T;
        if (stopped) return;
        setData((prev) => share(prev, next));
        setLastSuccessAt(Date.now());
        setFailures(0);
        failuresRef.current = 0;
      } catch {
        if (stopped || controller.signal.aborted) return;
        failuresRef.current += 1;
        setFailures((n) => n + 1);
      }
      schedule();
    }
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        setPaused(false);
        clearTimeout(timer);
        void run();
      }
    };
    trigger.current = () => {
      clearTimeout(timer);
      void run();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [url, intervalMs, enabled, backoff]);

  const checkNow = useCallback(() => trigger.current(), []);
  return { data, lastSuccessAt, failures, paused, checkNow };
}

/**
 * Structural sharing: returns `next`, but every sub-object or array that is deep-equal to the one in
 * `prev` is replaced by the `prev` instance (and `prev` itself when nothing changed). A 3 s poll that
 * brings back the same data then keeps object identities, so memoised children skip re-rendering and a
 * poll landing during a tap does not block it (INP, M4-07). Plain JSON values only.
 */
export function share<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev;
  if (typeof prev !== "object" || typeof next !== "object" || prev === null || next === null)
    return next;
  if (Array.isArray(prev) !== Array.isArray(next)) return next;
  if (Array.isArray(prev) && Array.isArray(next)) {
    const out = next.map((v, i) => share(prev[i], v));
    return (out.length === prev.length && out.every((v, i) => v === prev[i]) ? prev : out) as T;
  }
  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const keys = Object.keys(n);
  const out: Record<string, unknown> = {};
  let same = keys.length === Object.keys(p).length;
  for (const k of keys) {
    out[k] = share(p[k], n[k]);
    if (out[k] !== p[k]) same = false;
  }
  return (same ? prev : out) as T;
}

/** The current time, re-rendered every `everyMs` (for "checked 3 s ago"). */
export function useNow(everyMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
