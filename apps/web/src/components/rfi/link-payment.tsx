"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { formatWire } from "@/components/payments/format";
import { Button } from "@/components/ui/button";
import type { PaymentListResponse } from "@/server/payments";
import { t } from "@/strings";

/** The orphan-link action: an owner or approver links an unmatched request to one of the payments. */
export function LinkPayment({ rfiId, onLinked }: { rfiId: string; onLinked?: () => void }) {
  const id = useId();
  const router = useRouter();
  const [payments, setPayments] = useState<PaymentListResponse["items"]>([]);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/payments", { signal: controller.signal, cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<PaymentListResponse>) : null))
      .then((body) => body && setPayments(body.items))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  async function link() {
    if (!choice || busy) return;
    setBusy(true);
    setError(false);
    try {
      const res = await fetch(`/api/v1/rfis/${rfiId}/link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payment_id: choice }),
      });
      if (!res.ok) throw new Error("link failed");
      onLinked?.();
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        void link();
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm font-medium">
          {t.rfis.linkLabel}
        </label>
        <select
          id={id}
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          className="min-h-11 rounded-md border border-input bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-focus-ring md:min-h-10"
        >
          <option value="">{t.rfis.linkNone}</option>
          {payments.map((p) => (
            <option key={p.id} value={p.id}>
              {`${p.reference} ${formatWire(p.amount)}`}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant="secondary" disabled={!choice || busy}>
        {busy ? t.rfis.linkPending : t.rfis.linkCta}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-status-danger-fg">
          {t.rfis.linkError}
        </p>
      ) : null}
    </form>
  );
}
