"use client";

import {
  ArrowLeft,
  CircleCheck,
  CircleDashed,
  LoaderCircle,
  OctagonX,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { PaymentDetailResponse, PaymentDto } from "@/server/payments";
import { t } from "@/strings";
import { describeStatus, formatWhen, formatWire } from "./format";
import { LiveIndicator, StaleBanner } from "./live-status";
import { StatusBadge } from "./status-badge";
import { useNow, usePoll } from "./use-poll";
import { useStatusChanges } from "./use-status-changes";

const card = "flex flex-col gap-4 rounded-md border border-border bg-card p-4 md:p-6";

function Step({
  done,
  failed = false,
  label,
  at,
}: {
  done: boolean;
  failed?: boolean;
  label: string;
  at: string | null;
}) {
  const Icon = failed ? OctagonX : done ? CircleCheck : CircleDashed;
  return (
    <li className="flex items-start gap-3">
      <Icon
        aria-hidden="true"
        className={
          failed
            ? "mt-0.5 size-5 text-status-danger-fg"
            : done
              ? "mt-0.5 size-5 text-status-success-fg"
              : "mt-0.5 size-5 text-muted-foreground"
        }
      />
      <span className="flex flex-col">
        <span className="font-medium">{label}</span>
        <span className="text-sm text-muted-foreground">
          {at ? <time dateTime={at}>{formatWhen(at)}</time> : t.payments.detail.stepWaiting}
        </span>
      </span>
    </li>
  );
}

function Progress({ payment }: { payment: PaymentDto }) {
  const a = payment.attempt;
  const refused = a?.status === "REJECTED";
  // A transfer id means Airwallex has the transfer, so it was sent: the steps never contradict.
  const confirmed = !refused && (a?.status === "CONFIRMED" || payment.transfer_id !== null);
  const sent = Boolean(a?.sent_at) || confirmed || refused;
  const sentAt =
    a?.sent_at ?? (confirmed ? (a?.confirmed_at ?? payment.transfer_updated_at) : null);
  return (
    <section aria-labelledby="progress-title" className={card}>
      <h2 id="progress-title" className="text-lg leading-tight font-semibold">
        {t.payments.detail.progress}
      </h2>
      <ol className="flex flex-col gap-3">
        <Step done label={t.payments.detail.stepSaved} at={a?.created_at ?? payment.created_at} />
        <Step done={sent} label={t.payments.detail.stepSent} at={sentAt} />
        {refused ? (
          <Step
            done
            failed
            label={t.payments.detail.stepRefused}
            at={a?.confirmed_at ?? a?.sent_at ?? null}
          />
        ) : (
          <Step
            done={confirmed}
            label={t.payments.detail.stepConfirmed}
            at={a?.confirmed_at ?? (confirmed ? payment.transfer_updated_at : null)}
          />
        )}
      </ol>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function TransferFacts({ payment }: { payment: PaymentDto }) {
  const d = t.payments.detail;
  return (
    <section aria-labelledby="transfer-title" className={card}>
      <h2 id="transfer-title" className="text-lg leading-tight font-semibold">
        {d.transfer}
      </h2>
      <dl className="grid gap-4 sm:grid-cols-2">
        <Field label={d.transferId}>
          <span className="font-mono text-sm break-all">{payment.transfer_id ?? d.notYet}</span>
        </Field>
        <Field label={d.requestId}>
          <span className="font-mono text-sm break-all">
            {payment.attempt?.request_id ?? d.notYet}
          </span>
        </Field>
        <Field label={d.method}>{payment.method}</Field>
        {payment.failure_type ? (
          <Field label={d.failureCode}>
            <span className="font-mono text-sm">{payment.failure_type}</span>
          </Field>
        ) : null}
        <Field label={d.lastUpdate}>
          {payment.transfer_updated_at ? (
            <time dateTime={payment.transfer_updated_at}>
              {formatWhen(payment.transfer_updated_at)}
            </time>
          ) : (
            d.notYet
          )}
        </Field>
      </dl>
    </section>
  );
}

function Webhooks({ data }: { data: PaymentDetailResponse }) {
  const d = t.payments.detail;
  return (
    <section aria-labelledby="webhooks-title" className={card}>
      <h2 id="webhooks-title" className="text-lg leading-tight font-semibold">
        {d.webhooks}
      </h2>
      {data.webhooks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{d.webhooksEmpty}</p>
      ) : (
        <div className="-mx-4 overflow-x-auto md:mx-0">
          <table className="w-full min-w-[36rem] text-sm">
            <caption className="sr-only">{d.webhooksCaption}</caption>
            <thead className="border-b border-border text-left text-xs font-medium text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2">
                  {d.event}
                </th>
                <th scope="col" className="px-4 py-2">
                  {d.received}
                </th>
                <th scope="col" className="px-4 py-2">
                  {d.signature}
                </th>
                <th scope="col" className="px-4 py-2">
                  {d.processed}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.webhooks.map((w) => (
                <tr key={w.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2 font-mono text-xs">{w.name}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    <time dateTime={w.received_at}>{formatWhen(w.received_at)}</time>
                  </td>
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      {w.signature_ok ? (
                        <ShieldCheck aria-hidden="true" className="size-4 text-status-success-fg" />
                      ) : (
                        <ShieldX aria-hidden="true" className="size-4 text-status-danger-fg" />
                      )}
                      {w.signature_ok ? d.signatureOk : d.signatureBad}
                    </span>
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {w.processed_at ? (
                      <time dateTime={w.processed_at}>{formatWhen(w.processed_at)}</time>
                    ) : (
                      d.pending
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SimulateControls({ payment }: { payment: PaymentDto }) {
  const s = t.payments.simulate;
  const [pending, setPending] = useState<"SENT" | "PAID" | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // The sandbox takes SENT from SCHEDULED or PROCESSING and PAID from SENT (docs/evidence/
  // airwallex-money-path.md); a finished, refused or not-yet-created payment has nothing to simulate.
  const st = payment.transfer_status;
  const allowed = {
    SENT: st === "SCHEDULED" || st === "PROCESSING",
    PAID: st === "SENT",
  } as const;
  const waiting = payment.transfer_id === null && payment.attempt?.status !== "REJECTED";
  const reason = waiting ? s.needsTransfer : allowed.SENT || allowed.PAID ? null : s.noneAvailable;

  async function request(nextStatus: "SENT" | "PAID") {
    setPending(nextStatus);
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/payments/${payment.id}/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ next_status: nextStatus }),
      });
      setMessage(
        res.status === 202 ? { kind: "ok", text: s.queued } : { kind: "error", text: s.error },
      );
    } catch {
      setMessage({ kind: "error", text: s.error });
    }
    setPending(null);
  }

  return (
    <section aria-labelledby="simulate-title" className={card}>
      <div className="flex flex-col gap-1">
        <h2 id="simulate-title" className="text-lg leading-tight font-semibold">
          {s.title}
        </h2>
        <p className="max-w-[65ch] text-sm text-muted-foreground">{s.body}</p>
      </div>
      <div className="flex flex-wrap gap-3">
        {(["SENT", "PAID"] as const).map((next) => (
          <Button
            key={next}
            variant="outline"
            disabled={!allowed[next] || pending !== null}
            aria-busy={pending === next || undefined}
            onClick={() => request(next)}
          >
            {pending === next ? <LoaderCircle aria-hidden="true" /> : null}
            {pending === next ? s.pending : next === "SENT" ? s.sent : s.paid}
          </Button>
        ))}
      </div>
      {reason ? <p className="text-sm text-muted-foreground">{reason}</p> : null}
      <p
        role={message?.kind === "error" ? "alert" : undefined}
        className={
          message?.kind === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
        }
      >
        {message?.text}
      </p>
    </section>
  );
}

/**
 * The payment detail (M1-08): status badge with its reason line, the "waiting for Airwallex" step
 * list, the transfer facts, the webhooks that named the transfer, and (owner only) the sandbox
 * controls. Polled every 3 s; a status transition is announced through the shell live region.
 */
export function PaymentDetail({
  initial,
  canSimulate,
}: {
  initial: PaymentDetailResponse;
  canSimulate: boolean;
}) {
  const poll = usePoll<PaymentDetailResponse>(`/api/v1/payments/${initial.payment.id}`, initial);
  const now = useNow();
  const payment = poll.data.payment;
  useStatusChanges([payment]);
  const status = describeStatus(payment);

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/payments"
        className="inline-flex min-h-11 w-fit items-center gap-2 text-sm font-medium text-primary underline underline-offset-4 hover:no-underline md:min-h-6"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t.payments.detail.back}
      </Link>
      <StaleBanner lastSuccessAt={poll.lastSuccessAt} now={now} onCheckNow={poll.checkNow} />
      <header className="flex flex-col gap-3">
        <h1 className="text-xl leading-tight font-semibold break-words md:text-2xl">
          {payment.reference}
        </h1>
        <p className="text-2xl font-semibold tabular-nums">{formatWire(payment.amount)}</p>
        <div className="flex flex-col gap-2" data-testid="payment-status">
          <span className="sr-only">{t.status.label}</span>
          <StatusBadge status={status} size="md" showHint />
          {payment.failure_type ? (
            <p className="max-w-[65ch] text-sm">{t.payments.detail.failedNext}</p>
          ) : null}
        </div>
        <LiveIndicator
          lastSuccessAt={poll.lastSuccessAt}
          failures={poll.failures}
          paused={poll.paused}
          now={now}
        />
      </header>
      <div className="grid gap-6 lg:grid-cols-2">
        <Progress payment={payment} />
        <TransferFacts payment={payment} />
      </div>
      <Webhooks data={poll.data} />
      {canSimulate ? <SimulateControls payment={payment} /> : null}
    </div>
  );
}
