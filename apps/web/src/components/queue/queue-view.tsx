"use client";

import { Check, ListChecks } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo } from "react";
import { EvidenceStrength, type Flag } from "@/components/evidence/evidence-strength";
import { announce } from "@/components/payments/announce";
import { describeStatus, formatWhen, formatWire } from "@/components/payments/format";
import { StatusBadge } from "@/components/payments/status-badge";
import { EmptyState } from "@/components/shell/empty-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { QueueItemDto, QueueResponse } from "@/server/queue";
import { fill, t } from "@/strings";

// The payment queue (M2-03, docs/design/screens/payment-queue.md): every payment with the strength of its
// evidence and the transfer status Airwallex last reported. Filters live in the URL (`?flag=weak&status=
// not_sent`) so a view can be shared and the back button works. The server re-renders the list on a soft
// refresh (60 s, or 3 s while a payment waits for Airwallex); nothing here is optimistic.

const SEP = " \u00b7 ";
const FLAGS: readonly Flag[] = ["strong", "weak", "missing"];
const STATUS_FILTERS = ["not_sent", "in_flight", "paid"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function statusGroup(item: QueueItemDto): StatusFilter {
  const p = item.payment;
  if (p.transfer_status === "PAID") return "paid";
  if (p.transfer_status === null && p.attempt === null) return "not_sent";
  return "in_flight";
}

const waiting = (item: QueueItemDto) =>
  item.payment.attempt !== null && item.payment.transfer_status === null;

function useAutoRefresh(anyWaiting: boolean) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(
      () => {
        if (document.visibilityState === "visible") router.refresh();
      },
      anyWaiting ? 3_000 : 60_000,
    );
    return () => clearInterval(id);
  }, [router, anyWaiting]);
}

const chip =
  "inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium transition-colors duration-(--duration-fast) outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background md:min-h-9";

function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        chip,
        pressed
          ? "border-primary bg-accent text-accent-foreground"
          : "bg-background text-foreground hover:bg-accent",
      )}
    >
      {pressed ? <Check aria-hidden="true" className="size-4" /> : null}
      {children}
    </button>
  );
}

function nextStep(item: QueueItemDto): { label: string; href: string } {
  const p = item.payment;
  if (p.attempt === null && p.transfer_status === null) {
    return { label: t.queue.next.review, href: `/payments/${p.id}/evidence` };
  }
  return waiting(item)
    ? { label: t.queue.next.waiting, href: `/payments/${p.id}` }
    : { label: t.queue.next.view, href: `/payments/${p.id}` };
}

export function QueueView({ initial, canCreate }: { initial: QueueResponse; canCreate: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const flag = FLAGS.find((f) => f === params.get("flag")) ?? null;
  const status = STATUS_FILTERS.find((s) => s === params.get("status")) ?? null;
  const items = initial.items;
  useAutoRefresh(items.some(waiting));

  const shown = useMemo(
    () =>
      items.filter(
        (i) => (flag === null || i.flag === flag) && (status === null || statusGroup(i) === status),
      ),
    [items, flag, status],
  );
  const counts = useMemo(
    () => ({
      total: items.length,
      strong: items.filter((i) => i.flag === "strong").length,
      weak: items.filter((i) => i.flag === "weak").length,
      missing: items.filter((i) => i.flag === "missing").length,
    }),
    [items],
  );

  function setFilter(key: "flag" | "status", value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (value === null || next.get(key) === value) next.delete(key);
    else next.set(key, value);
    const query = next.toString();
    router.replace(query ? `?${query}` : "?", { scroll: false });
    // The count is announced after a filter the user chose (not on every refresh).
    const after = items.filter(
      (i) =>
        (key === "flag"
          ? value === null || next.get("flag") === i.flag
          : flag === null || i.flag === flag) &&
        (key === "status"
          ? value === null || next.get("status") === statusGroup(i)
          : status === null || statusGroup(i) === status),
    ).length;
    announce(
      after === 1
        ? t.queue.filter.resultCountOne
        : fill(t.queue.filter.resultCount, { count: after }),
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={ListChecks}
        title={t.queue.empty.title}
        body={t.queue.empty.body}
        action={
          canCreate ? (
            <Button asChild>
              <Link href="/payments">{t.queue.empty.cta}</Link>
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground" data-testid="queue-summary">
        {fill(t.queue.summary.counts, counts)}
        {SEP}
        {shown.length === 1
          ? t.queue.filter.resultCountOne
          : fill(t.queue.filter.resultCount, { count: shown.length })}
      </p>

      <section aria-label={t.queue.filter.label} className="flex flex-col gap-3">
        <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
          <legend className="mr-2 flex min-h-9 items-center text-sm font-medium text-muted-foreground">
            {t.queue.filter.evidenceGroup}
          </legend>
          <Chip pressed={flag === null} onClick={() => setFilter("flag", null)}>
            {t.queue.filter.all}
          </Chip>
          {FLAGS.map((f) => (
            <Chip key={f} pressed={flag === f} onClick={() => setFilter("flag", f)}>
              {t.queue.filter[f]}
            </Chip>
          ))}
        </fieldset>
        <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
          <legend className="mr-2 flex min-h-9 items-center text-sm font-medium text-muted-foreground">
            {t.queue.filter.statusGroup}
          </legend>
          <Chip pressed={status === null} onClick={() => setFilter("status", null)}>
            {t.queue.filter.all}
          </Chip>
          {STATUS_FILTERS.map((s) => (
            <Chip key={s} pressed={status === s} onClick={() => setFilter("status", s)}>
              {
                t.queue.filter[
                  s === "not_sent" ? "notSent" : s === "in_flight" ? "inFlight" : "paid"
                ]
              }
            </Chip>
          ))}
        </fieldset>
      </section>

      {shown.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title={t.queue.emptyFiltered.title}
          body={t.queue.emptyFiltered.body}
          action={
            <Button
              variant="outline"
              onClick={() => {
                router.replace("?", { scroll: false });
                announce(fill(t.queue.filter.resultCount, { count: items.length }));
              }}
            >
              {t.queue.filter.clear}
            </Button>
          }
        />
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-md border border-border bg-card md:block">
            <table className="w-full text-sm" data-testid="queue-table">
              <caption className="sr-only">{t.queue.table.caption}</caption>
              <thead className="border-b border-border bg-muted text-left text-xs font-medium text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3">
                    {t.queue.table.counterparty}
                  </th>
                  <th scope="col" className="px-4 py-3 text-right">
                    {t.queue.table.amount}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t.queue.table.evidence}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t.queue.table.status}
                  </th>
                  <th scope="col" className="px-4 py-3">
                    {t.queue.table.nextStep}
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => {
                  const step = nextStep(item);
                  return (
                    <tr
                      key={item.payment.id}
                      data-payment-id={item.payment.id}
                      className="border-b border-border last:border-b-0"
                    >
                      <th scope="row" className="px-4 py-3 text-left font-normal">
                        <Link
                          href={`/payments/${item.payment.id}/evidence`}
                          className="inline-flex min-h-6 font-medium text-primary underline underline-offset-4 hover:no-underline"
                        >
                          {item.payee ?? t.queue.unnamedPayee}
                        </Link>
                        <span className="block text-xs text-muted-foreground">
                          {item.payment.reference}
                          {SEP}
                          <time dateTime={item.payment.created_at}>
                            {formatWhen(item.payment.created_at)}
                          </time>
                        </span>
                      </th>
                      <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                        {formatWire(item.payment.amount)}
                      </td>
                      <td className="px-4 py-3">
                        <EvidenceStrength flag={item.flag} />
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={describeStatus(item.payment)} />
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={step.href}
                          className="font-medium text-primary underline underline-offset-4 hover:no-underline"
                        >
                          {step.label}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="flex flex-col gap-3 md:hidden" aria-label={t.queue.table.caption}>
            {shown.map((item) => (
              <li key={item.payment.id} className="rounded-md border border-border bg-card p-4">
                <Link
                  href={`/payments/${item.payment.id}/evidence`}
                  className="flex min-h-11 flex-col gap-2"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="font-medium text-primary underline underline-offset-4">
                      {item.payee ?? t.queue.unnamedPayee}
                    </span>
                    <span className="whitespace-nowrap tabular-nums">
                      {formatWire(item.payment.amount)}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">{item.payment.reference}</span>
                  <span className="flex flex-wrap gap-2">
                    <EvidenceStrength flag={item.flag} />
                    <StatusBadge status={describeStatus(item.payment)} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
