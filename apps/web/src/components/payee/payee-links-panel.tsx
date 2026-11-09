"use client";

import { Link2, LinkIcon } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/intl";
import { locale, t } from "@/strings";

// Owner panel for payee status links (M3-06). The address of a new link is shown once, in this
// component's memory, and never stored in the browser. Carnet sends nothing: the owner copies it.
type Level = "GENERIC" | "DELAYED_FOR_VERIFICATION";
type State = "active" | "expired" | "revoked";

interface LinkRow {
  id: string;
  disclosure_level: Level;
  state: State;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  last_viewed_at: string | null;
}

type Load = { kind: "loading" } | { kind: "error" } | { kind: "ready"; links: LinkRow[] };

const fieldClass =
  "min-h-11 w-28 rounded-md border border-input bg-background px-3 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-focus-ring md:min-h-10";

const when = (iso: string) => formatDate(iso, locale, { dateStyle: "medium", timeStyle: "short" });
const stateWord = {
  active: t.payee.owner.stateActive,
  expired: t.payee.owner.stateExpired,
  revoked: t.payee.owner.stateRevoked,
};
const stateTone = {
  active: "bg-status-success-bg text-status-success-fg",
  expired: "bg-status-neutral-bg text-status-neutral-fg",
  revoked: "bg-status-neutral-bg text-status-neutral-fg",
};

function newIdempotencyKey(): string {
  return `payee-link-${crypto.randomUUID()}`;
}

export function PayeeLinksPanel({
  paymentId,
  canManage,
  defaultHours,
}: {
  paymentId: string;
  canManage: boolean;
  defaultHours: number;
}) {
  const base = `/api/v1/payments/${paymentId}/payee-links`;
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [level, setLevel] = useState<Level>("GENERIC");
  const [hours, setHours] = useState(String(defaultHours));
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // One key per intent: a retry after a network failure reuses it, so the server never makes two links.
  const key = useRef(newIdempotencyKey());

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(base, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error("load");
      const data = (await res.json()) as { items: LinkRow[] };
      setLoad({ kind: "ready", links: data.items });
    } catch {
      setLoad({ kind: "error" });
    }
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setMessage(null);
    setCopied(false);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key.current },
        body: JSON.stringify({ disclosure_level: level, expires_in_hours: Number(hours) }),
      });
      if (res.status === 403) {
        setMessage(t.payee.owner.errorForbidden);
      } else if (!res.ok) {
        setMessage(t.payee.owner.errorCreate);
      } else {
        const data = (await res.json()) as { path: string | null; replayed: boolean };
        if (data.path) {
          setFresh(`${window.location.origin}${data.path}`);
        } else {
          setFresh(null);
          setMessage(t.payee.owner.replayed);
        }
        key.current = newIdempotencyKey();
        await refresh();
      }
    } catch {
      setMessage(t.payee.owner.errorCreate);
    }
    setCreating(false);
  }

  async function onRevoke(link: LinkRow) {
    setRevoking(link.id);
    setMessage(null);
    try {
      const res = await fetch(`${base}/${link.id}`, { method: "DELETE" });
      if (!res.ok)
        setMessage(res.status === 403 ? t.payee.owner.errorForbidden : t.payee.owner.errorRevoke);
      else await refresh();
    } catch {
      setMessage(t.payee.owner.errorRevoke);
    }
    setRevoking(null);
  }

  async function onCopy() {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section aria-labelledby="payee-links-title" className="flex max-w-2xl flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2
          id="payee-links-title"
          className="flex items-center gap-2 text-lg leading-tight font-semibold"
        >
          <Link2 aria-hidden="true" className="size-5" />
          {t.payee.owner.title}
        </h2>
        <p className="max-w-[65ch] text-pretty text-muted-foreground">{t.payee.owner.intro}</p>
      </div>

      {canManage ? (
        <form
          onSubmit={onCreate}
          className="flex flex-col gap-4 rounded-md border border-border bg-card p-4"
        >
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-medium">{t.payee.owner.levelLegend}</legend>
            {(
              [
                ["GENERIC", t.payee.owner.levelGeneric, t.payee.owner.levelGenericHint],
                [
                  "DELAYED_FOR_VERIFICATION",
                  t.payee.owner.levelDelayed,
                  t.payee.owner.levelDelayedHint,
                ],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className="flex min-h-11 cursor-pointer items-start gap-3 md:min-h-6"
              >
                <input
                  type="radio"
                  name="disclosure_level"
                  value={value}
                  checked={level === value}
                  onChange={() => setLevel(value)}
                  aria-describedby={`level-hint-${value}`}
                  className="mt-1 size-4 accent-primary"
                />
                <span className="flex flex-col">
                  <span className="font-medium">{label}</span>
                  <span id={`level-hint-${value}`} className="text-sm text-muted-foreground">
                    {hint}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="payee-link-hours" className="text-sm font-medium">
              {t.payee.owner.expiryLabel}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="payee-link-hours"
                type="number"
                inputMode="numeric"
                min={1}
                max={720}
                step={1}
                required
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                aria-describedby="payee-link-hours-hint"
                className={fieldClass}
              />
              <span>{t.payee.owner.expiryHours}</span>
            </div>
            <p id="payee-link-hours-hint" className="text-sm text-muted-foreground">
              {t.payee.owner.expiryHint}
            </p>
          </div>
          <div>
            <Button type="submit" disabled={creating} aria-busy={creating}>
              <LinkIcon aria-hidden="true" />
              {creating ? t.payee.owner.createPending : t.payee.owner.create}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">{t.payee.owner.readOnly}</p>
      )}

      <p role="alert" className="min-h-5 text-sm text-destructive">
        {message}
      </p>

      {fresh ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-status-success-bg p-4 text-status-success-fg">
          <h3 className="font-semibold">{t.payee.owner.newLinkTitle}</h3>
          <p className="text-sm">{t.payee.owner.newLinkHint}</p>
          <label htmlFor="payee-link-address" className="text-sm font-medium">
            {t.payee.owner.linkLabel}
          </label>
          <input
            id="payee-link-address"
            readOnly
            value={fresh}
            onFocus={(e) => e.currentTarget.select()}
            className="min-h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground md:min-h-10"
          />
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" onClick={onCopy}>
              {t.payee.owner.copy}
            </Button>
            <span role="status" className="text-sm">
              {copied ? t.payee.owner.copied : ""}
            </span>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <h3 className="text-base font-semibold">{t.payee.owner.listTitle}</h3>
        {load.kind === "loading" ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t.payee.owner.loading}
          </p>
        ) : load.kind === "error" ? (
          <div className="flex flex-col items-start gap-2">
            <p role="alert" className="text-sm text-destructive">
              {t.payee.owner.errorLoad}
            </p>
            <Button type="button" variant="outline" onClick={() => void refresh()}>
              {t.common.state.retry}
            </Button>
          </div>
        ) : load.links.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.payee.owner.empty}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {load.links.map((link) => (
              <li
                key={link.id}
                className="flex flex-col gap-2 rounded-md border border-border bg-card p-4 md:flex-row md:items-center md:justify-between"
              >
                <div className="flex flex-col gap-1 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-sm px-2 py-0.5 text-xs font-medium ${stateTone[link.state]}`}
                    >
                      {stateWord[link.state]}
                    </span>
                    <span className="font-medium">
                      {link.disclosure_level === "GENERIC"
                        ? t.payee.owner.levelGeneric
                        : t.payee.owner.levelDelayed}
                    </span>
                  </div>
                  <span className="text-muted-foreground">
                    {t.payee.owner.created}{" "}
                    <time dateTime={link.created_at}>{when(link.created_at)}</time>
                  </span>
                  <span className="text-muted-foreground">
                    {t.payee.owner.expires}{" "}
                    <time dateTime={link.expires_at}>{when(link.expires_at)}</time>
                  </span>
                  <span className="text-muted-foreground">
                    {link.last_viewed_at ? (
                      <>
                        {t.payee.owner.lastViewed}{" "}
                        <time dateTime={link.last_viewed_at}>{when(link.last_viewed_at)}</time>
                      </>
                    ) : (
                      t.payee.owner.neverViewed
                    )}
                  </span>
                </div>
                {canManage && link.state !== "revoked" ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={revoking === link.id}
                    aria-busy={revoking === link.id}
                    aria-label={t.payee.owner.revokeLabel.replace(
                      "{created}",
                      when(link.created_at),
                    )}
                    onClick={() => void onRevoke(link)}
                  >
                    {revoking === link.id ? t.payee.owner.revokePending : t.payee.owner.revoke}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
