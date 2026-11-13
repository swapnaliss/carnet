"use client";

import { CircleCheck, CirclePause } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { fill, t } from "@/strings";

type FlagName = "agents_enabled" | "execution_enabled";

const COPY = {
  agents_enabled: {
    name: () => t.ops.governance.agents,
    on: () => t.ops.governance.agentsOn,
    off: () => t.ops.governance.agentsOff,
    definition: () => t.ops.governance.agentsDefinition,
    pause: () => t.ops.governance.pauseAgents,
    resume: () => t.ops.governance.resumeAgents,
    confirm: () => t.ops.governance.confirmAgents,
  },
  execution_enabled: {
    name: () => t.ops.governance.execution,
    on: () => t.ops.governance.executionOn,
    off: () => t.ops.governance.executionOff,
    definition: () => t.ops.governance.executionDefinition,
    pause: () => t.ops.governance.pauseExecution,
    resume: () => t.ops.governance.resumeExecution,
    confirm: () => t.ops.governance.confirmExecution,
  },
} as const;

/**
 * One kill switch (docs/design/screens/ops.md): the state as text, what it does, and a button that
 * names the action ("Pause execution"), never a toggle. Pausing asks for a confirmation that
 * repeats the effect; resuming does not. The server confirms before the state changes on screen,
 * and the change is announced assertively. Only the owner gets the button.
 */
export function SwitchControl({
  flag,
  enabled,
  canChange,
  lastChange,
}: {
  flag: FlagName;
  enabled: boolean;
  canChange: boolean;
  /** "Changed by … at …" or "Never changed", already formatted on the server. */
  lastChange: string;
}) {
  const copy = COPY[flag];
  const router = useRouter();
  const reasonId = useId();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (confirming && !d.open) d.showModal();
    if (!confirming && d.open) d.close();
  }, [confirming]);

  async function change(next: boolean, reason: string) {
    setPending(true);
    setFailed(false);
    try {
      const res = await fetch("/api/ops/flags", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flag, enabled: next, ...(reason ? { reason } : {}) }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setConfirming(false);
      setAnnouncement(
        fill(next ? t.ops.governance.announceOn : t.ops.governance.announceOff, {
          name: copy.name(),
        }),
      );
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  const StateIcon = enabled ? CircleCheck : CirclePause;
  return (
    <article
      aria-labelledby={`${flag}-title`}
      data-testid={`switch-${flag}`}
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-4 md:p-5"
    >
      <h3 id={`${flag}-title`} className="text-base leading-snug font-semibold">
        {copy.name()}
      </h3>
      <p
        data-testid={`switch-${flag}-state`}
        className={`flex items-center gap-2 text-xl leading-tight font-semibold ${
          enabled ? "text-status-success-fg" : "text-status-danger-fg"
        }`}
      >
        <StateIcon aria-hidden="true" className="size-5 shrink-0" />
        {enabled ? copy.on() : copy.off()}
      </p>
      <p className="text-sm text-pretty text-muted-foreground">{copy.definition()}</p>
      <p className="text-sm text-muted-foreground">{lastChange}</p>

      {canChange ? (
        <>
          <dialog
            ref={dialogRef}
            aria-labelledby={`${flag}-confirm-title`}
            onClose={() => setConfirming(false)}
            className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-md border border-border bg-card p-0 text-foreground backdrop:bg-black/50"
          >
            <form
              className="flex flex-col gap-3 p-5"
              onSubmit={(e) => {
                e.preventDefault();
                const reason = String(new FormData(e.currentTarget).get("reason") ?? "").trim();
                void change(false, reason);
              }}
            >
              <h4 id={`${flag}-confirm-title`} className="text-lg font-semibold">
                {fill(t.ops.governance.confirmTitle, { name: copy.name().toLowerCase() })}
              </h4>
              <p className="text-sm text-pretty">{copy.confirm()}</p>
              <label htmlFor={reasonId} className="text-sm font-medium">
                {t.ops.governance.reasonLabel}
              </label>
              <input
                id={reasonId}
                name="reason"
                maxLength={500}
                className="min-h-12 rounded-md border border-border bg-background px-3 md:min-h-10"
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="destructive" disabled={pending}>
                  {pending ? t.ops.governance.pending : t.ops.governance.confirmCta}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setConfirming(false)}
                >
                  {t.ops.governance.cancel}
                </Button>
              </div>
            </form>
          </dialog>
          <div>
            <Button
              type="button"
              className="min-h-12 w-full sm:w-auto"
              variant={enabled ? "outline" : "default"}
              disabled={pending}
              data-testid={`switch-${flag}-button`}
              onClick={() => (enabled ? setConfirming(true) : void change(true, ""))}
            >
              {pending ? t.ops.governance.pending : enabled ? copy.pause() : copy.resume()}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t.ops.governance.ownerOnly}</p>
      )}
      {failed ? (
        <p role="alert" className="text-sm text-status-danger-fg">
          {t.ops.governance.error}
        </p>
      ) : null}
      <p aria-live="assertive" className="sr-only">
        {announcement}
      </p>
    </article>
  );
}
