"use client";

import { Check, CircleAlert, ListChecks, Target } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo } from "react";
import { EvidenceStrength, type Flag } from "@/components/evidence/evidence-strength";
import { announce } from "@/components/payments/announce";
import { describeStatus, formatWire } from "@/components/payments/format";
import { StatusBadge } from "@/components/payments/status-badge";
import { EmptyState } from "@/components/shell/empty-state";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/intl";
import { cn } from "@/lib/utils";
import type { QueueItemDto, QueueResponse } from "@/server/queue";
import { fill, locale, t } from "@/strings";

// The payment queue (M2-03, docs/design/screens/payment-queue.md): the goal, what is held, and every
// payment with the strength of its evidence and the transfer status Airwallex last reported. Filters
// live in the URL (`?show=held&flag=weak&currency=EUR`) so a view can be shared and the back button
// works. The server re-renders on a soft refresh (60 s, or 3 s while a payment waits for Airwallex).
// Due dates, criticality and the goal come from obligations (a later ticket): until they exist the
// screen says "Not set" instead of inventing them.

const SEP = " \u00b7 ";
const FLAGS: readonly Flag[] = ["strong", "weak", "missing"];
const SHOWS = ["held", "needs_evidence", "not_sent", "in_flight", "paid"] as const;
type Show = (typeof SHOWS)[number];
const SHOW_LABEL: Record<Show, string> = {
  held: t.queue.filter.held,
  needs_evidence: t.queue.filter.needsEvidence,
  not_sent: t.queue.filter.notSent,
  in_flight: t.queue.filter.inFlight,
  paid: t.queue.filter.paid,
};

function matches(item: QueueItemDto, show: Show): boolean {
  const p = item.payment;
  switch (show) {
    case "held":
      return item.held;
    case "needs_evidence":
      return item.flag !== "strong";
    case "paid":
      return p.transfer_status === "PAID";
    case "not_sent":
      return p.transfer_status === null && p.attempt === null;
    case "in_flight":
      return !(p.transfer_status === null && p.attempt === null) && p.transfer_status !== "PAID";
  }
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

function HeldBadge() {
  return (
    <span className="inline-flex min-h-6 items-center gap-1.5 rounded-sm border border-border bg-status-held-bg px-2 text-xs font-medium whitespace-nowrap text-status-held-fg">
      <CircleAlert aria-hidden="true" className="size-3.5" />
      {t.queue.held.badge}
    </span>
  );
}

function nextStep(item: QueueItemDto): { label: string; href: string } {
  const p = item.payment;
  if (item.held) {
    return {
      label: t.queue.held.cta,
      href: item.rfi_id ? `/rfis/${item.rfi_id}` : `/payments/${p.id}`,
    };
  }
  if (p.attempt === null && p.transfer_status === null) {
    return { label: t.queue.next.review, href: `/payments/${p.id}/evidence` };
  }
  return waiting(item)
    ? { label: t.queue.next.waiting, href: `/payments/${p.id}` }
    : { label: t.queue.next.view, href: `/payments/${p.id}` };
}

const legend = "mr-2 flex min-h-9 items-center text-sm font-medium text-muted-foreground";

export function QueueView({ initial, canCreate }: { initial: QueueResponse; canCreate: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const flag = FLAGS.find((f) => f === params.get("flag")) ?? null;
  const show = SHOWS.find((s) => s === params.get("show")) ?? null;
  const currencies = useMemo(
    () => [...new Set(initial.items.map((i) => i.payment.amount.currency))].sort(),
    [initial.items],
  );
  const currency = currencies.find((c) => c === params.get("currency")) ?? null;
  const items = initial.items;
  useAutoRefresh(items.some(waiting));

  const shown = useMemo(
    () =>
      items.filter(
        (i) =>
          (flag === null || i.flag === flag) &&
          (show === null || matches(i, show)) &&
          (currency === null || i.payment.amount.currency === currency),
      ),
    [items, flag, show, currency],
  );
  const held = items.filter((i) => i.held);
  const counts = {
    total: items.length,
    strong: items.filter((i) => i.flag === "strong").length,
    weak: items.filter((i) => i.flag === "weak").length,
    missing: items.filter((i) => i.flag === "missing").length,
    held: held.length,
    sent: items.filter((i) => i.payment.attempt !== null || i.payment.transfer_status !== null)
      .length,
    notSent: items.filter((i) => i.payment.attempt === null && i.payment.transfer_status === null)
      .length,
  };

  function setFilter(key: "flag" | "show" | "currency", value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (value === null || next.get(key) === value) next.delete(key);
    else next.set(key, value);
    const query = next.toString();
    router.replace(query ? `?${query}` : "?", { scroll: false });
    const after = items.filter(
      (i) =>
        (next.get("flag") === null || i.flag === next.get("flag")) &&
        (next.get("show") === null || matches(i, next.get("show") as Show)) &&
        (next.get("currency") === null || i.payment.amount.currency === next.get("currency")),
    ).length;
    announce(
      after === 1
        ? t.queue.filter.resultCountOne
        : fill(t.queue.filter.resultCount, { count: after }),
    );
  }

  const updated = formatDate(initial.server_time, locale, { timeStyle: "short" });

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground tabular-nums" data-testid="queue-updated">
        {fill(t.queue.updated, { time: updated })}
      </p>

      <section
        aria-labelledby="goal-title"
        className="flex flex-col gap-2 rounded-md border border-border bg-card p-4 md:p-6"
      >
        <h2
          id="goal-title"
          className="flex items-center gap-2 text-sm font-medium text-muted-foreground"
        >
          <Target aria-hidden="true" className="size-4" />
          {t.queue.goal.label}
        </h2>
        <p className="text-lg font-semibold">{t.queue.goal.emptyTitle}</p>
        <p className="max-w-[65ch] text-muted-foreground">{t.queue.goal.emptyBody}</p>
        <p className="text-sm text-muted-foreground" data-testid="queue-summary">
          {fill(t.queue.summary.counts, counts)}
        </p>
        <p>
          <Link
            href="/plan"
            className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline underline-offset-4 hover:no-underline md:min-h-6"
          >
            {t.queue.goal.planLink}
          </Link>
        </p>
      </section>

      {held[0] ? (
        <section
          aria-labelledby="held-title"
          data-testid="held-callout"
          className="flex flex-col gap-3 rounded-md border border-border bg-status-held-bg p-4 text-status-held-fg md:flex-row md:items-center md:justify-between md:p-6"
        >
          <div className="flex items-start gap-3">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <div className="flex flex-col gap-1">
              <h2 id="held-title" className="font-semibold">
                {t.queue.held.title}
              </h2>
              <p>
                {fill(t.queue.held.body, {
                  payee: held[0].payee ?? t.queue.unnamedPayee,
                  amount: formatWire(held[0].payment.amount),
                })}{" "}
                {held[0].rfi_expires_at
                  ? fill(t.queue.held.deadline, {
                      date: formatDate(held[0].rfi_expires_at, locale, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                    })
                  : t.queue.held.noDeadline}
              </p>
            </div>
          </div>
          <Button asChild className="w-full md:w-auto">
            <Link
              href={held[0].rfi_id ? `/rfis/${held[0].rfi_id}` : `/payments/${held[0].payment.id}`}
            >
              {t.queue.held.cta}
            </Link>
          </Button>
        </section>
      ) : null}

      {items.length === 0 ? (
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
      ) : (
        <>
          <section aria-label={t.queue.filter.label} className="flex flex-col gap-3">
            <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
              <legend className={legend}>{t.queue.filter.statusGroup}</legend>
              <Chip pressed={show === null} onClick={() => setFilter("show", null)}>
                {t.queue.filter.all}
              </Chip>
              {SHOWS.map((s) => (
                <Chip key={s} pressed={show === s} onClick={() => setFilter("show", s)}>
                  {SHOW_LABEL[s]}
                </Chip>
              ))}
            </fieldset>
            <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
              <legend className={legend}>{t.queue.filter.evidenceGroup}</legend>
              {FLAGS.map((f) => (
                <Chip key={f} pressed={flag === f} onClick={() => setFilter("flag", f)}>
                  {t.queue.filter[f]}
                </Chip>
              ))}
            </fieldset>
            {currencies.length > 1 ? (
              <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
                <legend className={legend}>{t.queue.filter.currencyGroup}</legend>
                {currencies.map((c) => (
                  <Chip key={c} pressed={currency === c} onClick={() => setFilter("currency", c)}>
                    {c}
                  </Chip>
                ))}
              </fieldset>
            ) : null}
            <p className="text-sm text-muted-foreground" data-testid="queue-count">
              {shown.length === 1
                ? t.queue.filter.resultCountOne
                : fill(t.queue.filter.resultCount, { count: shown.length })}
            </p>
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
              <div className="hidden overflow-hidden rounded-md border border-border bg-card xl:block">
                <table className="w-full text-sm" data-testid="queue-table">
                  <caption className="sr-only">{t.queue.table.caption}</caption>
                  <thead className="border-b border-border bg-muted text-left text-xs font-medium text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-4 py-3">
                        {t.queue.table.counterparty}
                      </th>
                      <th scope="col" className="px-4 py-3">
                        {t.queue.due}
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
                            </span>
                          </th>
                          <td className="px-4 py-3 text-muted-foreground">
                            <span title={t.queue.dueNotSet}>{"\u2014"}</span>
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                            {formatWire(item.payment.amount)}
                          </td>
                          <td className="px-4 py-3">
                            <EvidenceStrength flag={item.flag} />
                          </td>
                          <td className="px-4 py-3">
                            <span className="flex flex-wrap gap-1">
                              <StatusBadge status={describeStatus(item.payment)} />
                              {item.held ? <HeldBadge /> : null}
                            </span>
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
              <ul className="flex flex-col gap-3 xl:hidden" aria-label={t.queue.table.caption}>
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
                      <span className="text-xs text-muted-foreground">
                        {item.payment.reference}
                      </span>
                      <span className="flex flex-wrap gap-2">
                        <EvidenceStrength flag={item.flag} />
                        <StatusBadge status={describeStatus(item.payment)} />
                        {item.held ? <HeldBadge /> : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
