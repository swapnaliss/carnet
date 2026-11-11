"use client";

import { CircleAlert, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/strings";

// The owner's skeleton create form (M1-08). One Idempotency-Key per filled-in form: a double click or
// a retry after a network error reuses it, so the server creates at most one payment. Nothing is shown
// as created until the server answers 201; then the page moves to the payment.
const fieldClass =
  "min-h-11 w-full rounded-md border border-border bg-background px-3 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-focus-ring aria-invalid:border-destructive md:min-h-10";

const AMOUNT = /^(?=.*[1-9])\d{1,9}(?:\.\d{1,2})?$/;

type FieldErrors = { amount?: string; reference?: string };

function newKey(): string {
  return globalThis.crypto.randomUUID();
}

export function CreatePaymentForm() {
  const router = useRouter();
  const ids = useId();
  const [key, setKey] = useState(newKey);
  const [pending, setPending] = useState(false);
  const [fields, setFields] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const amount = String(form.get("amount") ?? "").trim();
    const reference = String(form.get("reference") ?? "").trim();
    const invalid: FieldErrors = {
      ...(AMOUNT.test(amount) ? {} : { amount: t.payments.create.errorAmount }),
      ...(reference ? {} : { reference: t.payments.create.errorReference }),
    };
    setFields(invalid);
    setError(null);
    if (invalid.amount || invalid.reference) return;
    setPending(true);
    try {
      const res = await fetch("/api/v1/payments", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        // Saved, not sent: the owner adds documents and sends from the evidence view (M2-03).
        body: JSON.stringify({ amount: { amount, currency: "USD" }, reference, send: false }),
      });
      const body = (await res.json().catch(() => null)) as {
        payment?: { id: string };
        error?: { code: string; message: string };
      } | null;
      if (res.status === 201 && body?.payment) {
        setKey(newKey());
        router.push(`/payments/${body.payment.id}/evidence`);
        return;
      }
      // Funding, upstream and key-reuse errors carry a message written for the owner (server copy).
      const code = body?.error?.code;
      setError(
        code === "PRECONDITION_FAILED" ||
          code === "UPSTREAM_ERROR" ||
          code === "IDEMPOTENCY_KEY_REUSED"
          ? (body?.error?.message ?? t.payments.create.errorGeneric)
          : t.payments.create.errorGeneric,
      );
      if (code === "IDEMPOTENCY_KEY_REUSED") setKey(newKey());
    } catch {
      setError(t.payments.create.errorOffline);
    }
    setPending(false);
  }

  const amountId = `${ids}-amount`;
  const referenceId = `${ids}-reference`;
  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="flex flex-col gap-4 rounded-md border border-border bg-card p-4 md:p-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${ids}-title`} className="text-lg leading-tight font-semibold">
          {t.payments.create.title}
        </h2>
        <p className="max-w-[65ch] text-sm text-muted-foreground">{t.payments.create.body}</p>
        <p className="max-w-[65ch] text-sm text-muted-foreground">{t.payments.create.draftHint}</p>
      </div>
      <form
        onSubmit={onSubmit}
        noValidate
        className="grid gap-4 md:grid-cols-[12rem_1fr_auto] md:items-start"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={amountId} className="text-sm font-medium">
            {t.payments.create.amount}
          </label>
          <input
            id={amountId}
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            defaultValue="25.00"
            aria-invalid={fields.amount ? true : undefined}
            aria-describedby={`${amountId}-hint${fields.amount ? ` ${amountId}-error` : ""}`}
            className={`${fieldClass} tabular-nums`}
          />
          <p id={`${amountId}-hint`} className="text-xs text-muted-foreground">
            {t.payments.create.amountHint}
          </p>
          {fields.amount ? (
            <p
              id={`${amountId}-error`}
              className="flex items-center gap-1.5 text-sm text-destructive"
            >
              <CircleAlert aria-hidden="true" className="size-4" />
              {fields.amount}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={referenceId} className="text-sm font-medium">
            {t.payments.create.reference}
          </label>
          <input
            id={referenceId}
            name="reference"
            maxLength={140}
            autoComplete="off"
            aria-invalid={fields.reference ? true : undefined}
            aria-describedby={`${referenceId}-hint${fields.reference ? ` ${referenceId}-error` : ""}`}
            className={fieldClass}
          />
          <p id={`${referenceId}-hint`} className="text-xs text-muted-foreground">
            {t.payments.create.referenceHint}
          </p>
          {fields.reference ? (
            <p
              id={`${referenceId}-error`}
              className="flex items-center gap-1.5 text-sm text-destructive"
            >
              <CircleAlert aria-hidden="true" className="size-4" />
              {fields.reference}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5 md:pt-[1.625rem]">
          <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
            {pending ? <LoaderCircle aria-hidden="true" /> : null}
            {pending ? t.payments.create.submitPending : t.payments.create.submit}
          </Button>
        </div>
      </form>
      {/* Page-anchored money error (docs/design/states.md): stays until the next attempt. */}
      <p role="alert" className="min-h-5 text-sm text-destructive empty:hidden">
        {error}
      </p>
    </section>
  );
}
