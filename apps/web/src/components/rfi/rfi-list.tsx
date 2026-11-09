"use client";

import { Inbox } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { announce } from "@/components/payments/announce";
import { formatWhen } from "@/components/payments/format";
import { EmptyState } from "@/components/shell/empty-state";
import { Button } from "@/components/ui/button";
import { fill, t } from "@/strings";
import { LinkPayment } from "./link-payment";
import { shortId } from "./view";

interface RfiItem {
  id: string;
  airwallex_rfi_id: string;
  state: string;
  round: number;
  expires_at: string | null;
  payment_id: string | null;
  orphan_reason: string | null;
}

type Load = { kind: "loading" } | { kind: "error" } | { kind: "ready"; items: RfiItem[] };

const label = (state: string) => t.hold.states[state as keyof typeof t.hold.states] ?? state;

function Row({ rfi, canLink, onLinked }: { rfi: RfiItem; canLink: boolean; onLinked: () => void }) {
  return (
    <li
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-4"
      data-testid="rfi-row"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-mono text-sm" title={rfi.airwallex_rfi_id}>
          {shortId(rfi.airwallex_rfi_id)}
        </span>
        <span className="inline-flex min-h-6 items-center rounded-sm border border-border bg-status-neutral-bg px-2 text-xs font-medium text-status-neutral-fg">
          {label(rfi.state)}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {rfi.expires_at
          ? fill(t.hold.header.deadline, { when: formatWhen(rfi.expires_at) })
          : t.hold.header.deadlineNone}
      </p>
      {rfi.payment_id === null && rfi.orphan_reason ? (
        <p className="text-sm text-muted-foreground">
          {t.rfis.reasons[rfi.orphan_reason as keyof typeof t.rfis.reasons] ?? rfi.orphan_reason}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-4">
        <Button asChild variant="outline">
          <Link href={`/rfis/${rfi.id}`}>
            {t.rfis.open}
            <span className="sr-only">
              {fill(t.hold.header.rfiId, { id: shortId(rfi.airwallex_rfi_id) })}
            </span>
          </Link>
        </Button>
        {rfi.payment_id === null && canLink ? (
          <LinkPayment rfiId={rfi.id} onLinked={onLinked} />
        ) : null}
      </div>
    </li>
  );
}

/** The request list: held payments' requests, then the orphan (account-level) queue. Polls every 3 s. */
export function RfiList({ canLink }: { canLink: boolean }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  const fetchList = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await fetch("/api/v1/rfis?limit=100", { cache: "no-store", signal });
      if (!res.ok) throw new Error("list failed");
      const body = (await res.json()) as { items: RfiItem[] };
      setLoad((prev) => {
        if (prev.kind === "ready" && prev.items.length !== body.items.length) {
          announce(fill(t.hold.live.stateChanged, { state: String(body.items.length) }));
        }
        return { kind: "ready", items: body.items };
      });
    } catch {
      if (!signal.aborted) setLoad((prev) => (prev.kind === "ready" ? prev : { kind: "error" }));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchList(controller.signal);
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void fetchList(controller.signal);
    }, 3_000);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, [fetchList]);

  if (load.kind === "loading") {
    return (
      <div aria-busy="true" data-testid="rfi-list-loading" className="flex flex-col gap-3">
        <p role="status" className="sr-only">
          {t.rfis.loading}
        </p>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            aria-hidden="true"
            className="h-32 animate-pulse rounded-md bg-muted motion-reduce:animate-none"
          />
        ))}
      </div>
    );
  }
  if (load.kind === "error") {
    return (
      <section
        role="alert"
        data-testid="rfi-list-error"
        className="flex max-w-2xl flex-col items-start gap-3 rounded-md border border-border bg-status-danger-bg p-6 text-status-danger-fg"
      >
        <h2 className="text-lg font-semibold">{t.rfis.error.title}</h2>
        <p>{t.rfis.error.body}</p>
        <Button
          variant="outline"
          onClick={() => {
            setLoad({ kind: "loading" });
            void fetchList(new AbortController().signal);
          }}
        >
          {t.hold.error.retry}
        </Button>
      </section>
    );
  }
  if (load.items.length === 0) {
    return <EmptyState icon={Inbox} title={t.rfis.empty.title} body={t.rfis.empty.body} />;
  }
  const linked = load.items.filter((r) => r.payment_id !== null);
  const orphans = load.items.filter((r) => r.payment_id === null);
  const refresh = () => void fetchList(new AbortController().signal);
  return (
    <div className="flex flex-col gap-8">
      {linked.length > 0 ? (
        <section aria-labelledby="linked-heading" className="flex flex-col gap-3">
          <h2 id="linked-heading" className="text-lg font-semibold">
            {t.rfis.linked}
          </h2>
          <ul className="flex flex-col gap-3">
            {linked.map((r) => (
              <Row key={r.id} rfi={r} canLink={canLink} onLinked={refresh} />
            ))}
          </ul>
        </section>
      ) : null}
      {orphans.length > 0 ? (
        <section aria-labelledby="orphan-heading" className="flex flex-col gap-3">
          <div>
            <h2 id="orphan-heading" className="text-lg font-semibold">
              {t.rfis.orphan}
            </h2>
            <p className="text-sm text-muted-foreground">{t.rfis.orphanHint}</p>
          </div>
          <ul className="flex flex-col gap-3">
            {orphans.map((r) => (
              <Row key={r.id} rfi={r} canLink={canLink} onLinked={refresh} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
