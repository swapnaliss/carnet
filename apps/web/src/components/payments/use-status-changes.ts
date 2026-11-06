"use client";

import { useEffect, useRef, useState } from "react";
// Announces a payment's status transition (and only a transition) through the shell live region, and
// reports which payments just changed so their row can be highlighted for a moment.
import type { PaymentDto } from "@/server/payments";
import { announce } from "./announce";
import { announcement, describeStatus } from "./format";

const HIGHLIGHT_MS = 1_500;

export function useStatusChanges(payments: readonly PaymentDto[]): ReadonlySet<string> {
  const seen = useRef<Map<string, string> | null>(null);
  const [changed, setChanged] = useState<ReadonlySet<string>>(() => new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const next = new Map(payments.map((p) => [p.id, describeStatus(p).key]));
    const before = seen.current;
    seen.current = next;
    if (before === null) return; // the first render is not a change
    const ids: string[] = [];
    for (const p of payments) {
      const prior = before.get(p.id);
      const status = describeStatus(p);
      if (prior !== undefined && prior !== status.key) {
        ids.push(p.id);
        announce(announcement(p, status));
      }
    }
    if (ids.length === 0) return;
    setChanged(new Set(ids));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setChanged(new Set()), HIGHLIGHT_MS);
  }, [payments]);

  useEffect(() => () => clearTimeout(timer.current), []);
  return changed;
}
