"use client";

// Pushes messages to the shell's one polite live region (`#live-region`, app-shell.tsx), following
// docs/design/accessibility.md: announce transitions, not polls; at most one announcement every 2 s;
// several changes that arrive together are combined into one message.
import { fill, t } from "@/strings";

export const ANNOUNCE_MIN_GAP_MS = 2_000;
const MAX_COMBINED = 3;

let queue: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let lastAt = 0;

function flush(): void {
  timer = undefined;
  const region = document.getElementById("live-region");
  const messages = queue;
  queue = [];
  if (!region || messages.length === 0) return;
  const text =
    messages.length === 1
      ? (messages[0] ?? "")
      : [
          fill(t.payments.announce.several, { count: messages.length }),
          ...messages.slice(-MAX_COMBINED),
        ].join(" ");
  lastAt = Date.now();
  region.textContent = text;
}

export function announce(message: string): void {
  queue.push(message);
  if (timer !== undefined) return;
  const wait = Math.max(0, lastAt + ANNOUNCE_MIN_GAP_MS - Date.now());
  // A short delay also gathers changes from the same poll into one message.
  timer = setTimeout(flush, Math.max(wait, 100));
}
