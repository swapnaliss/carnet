"use client";

import { Banknote } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/shell/empty-state";
import { cn } from "@/lib/utils";
import type { PaymentListResponse } from "@/server/payments";
import { t } from "@/strings";
import { describeStatus, formatWhen, formatWire } from "./format";
import { LiveIndicator, StaleBanner } from "./live-status";
import { StatusBadge } from "./status-badge";
import { useNow, usePoll } from "./use-poll";
import { useStatusChanges } from "./use-status-changes";

/**
 * The payment list (M1-08): server-rendered first, then polled every 3 s. A table from 768px (a real
 * link in the first cell), stacked rows below. A status transition is announced politely and the row
 * is tinted for a moment; a poll that keeps failing shows the StaleBanner after 15 s.
 */
export function PaymentList({
  initial,
  canCreate,
}: {
  initial: PaymentListResponse;
  canCreate: boolean;
}) {
  const poll = usePoll<PaymentListResponse>("/api/v1/payments", initial);
  const now = useNow();
  const items = poll.data.items;
  const changed = useStatusChanges(items);

  return (
    <div className="flex flex-col gap-4">
      <StaleBanner lastSuccessAt={poll.lastSuccessAt} now={now} onCheckNow={poll.checkNow} />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg leading-tight font-semibold">{t.payments.list.title}</h2>
        <LiveIndicator
          lastSuccessAt={poll.lastSuccessAt}
          failures={poll.failures}
          paused={poll.paused}
          now={now}
        />
      </div>
      {items.length === 0 ? (
        <EmptyState
          icon={Banknote}
          title={t.payments.empty.title}
          body={canCreate ? t.payments.empty.bodyOwner : t.payments.empty.bodyViewer}
        />
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-md border border-border bg-card md:block">
            <table className="w-full text-sm">
              <caption className="sr-only">{t.payments.list.caption}</caption>
              <thead className="border-b border-border bg-muted text-left text-xs font-medium text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    {t.payments.list.reference}
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    {t.payments.list.amount}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t.payments.list.status}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t.payments.list.created}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr
                    key={p.id}
                    data-payment-id={p.id}
                    className={cn(
                      "border-b border-border transition-colors duration-(--duration-slow) last:border-b-0",
                      changed.has(p.id) && "bg-accent",
                    )}
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/payments/${p.id}`}
                        className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline md:min-h-6"
                      >
                        {p.reference}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                      {formatWire(p.amount)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={describeStatus(p)} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      <time dateTime={p.created_at}>{formatWhen(p.created_at)}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col gap-3 md:hidden" aria-label={t.payments.list.caption}>
            {items.map((p) => (
              <li
                key={p.id}
                className={cn(
                  "rounded-md border border-border bg-card p-4 transition-colors duration-(--duration-slow)",
                  changed.has(p.id) && "bg-accent",
                )}
              >
                <Link href={`/payments/${p.id}`} className="flex min-h-11 flex-col gap-2">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-primary underline underline-offset-4">
                      {p.reference}
                    </span>
                    <span className="whitespace-nowrap tabular-nums">{formatWire(p.amount)}</span>
                  </span>
                  <StatusBadge status={describeStatus(p)} />
                  <time dateTime={p.created_at} className="text-xs text-muted-foreground">
                    {formatWhen(p.created_at)}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
