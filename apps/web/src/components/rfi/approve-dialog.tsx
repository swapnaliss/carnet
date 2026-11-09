"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type { HoldView } from "@/server/hold";
import { fill, t } from "@/strings";
import { Modal } from "./modal";
import {
  type ApproveBody,
  buildApproveBody,
  formatBytes,
  shortId,
  unverifiedStatements,
} from "./view";

export interface ApproveSnapshot {
  /** Taken when the dialog opened: what the owner reads is what is sent. */
  readonly view: HoldView;
  readonly body: ApproveBody;
  readonly key: string;
}

export function makeSnapshot(view: HoldView): ApproveSnapshot | null {
  const body = buildApproveBody(view);
  return body ? { view, body, key: crypto.randomUUID() } : null;
}

type Outcome =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "changed" }
  | { kind: "error"; message: string };

/**
 * The approval dialog: shows exactly the content that will be sent (every title, final text, file
 * name and hash, unverified statements, the request id and round, the content identifiers) and sends
 * the request built from the same snapshot. Nothing is recorded as approved until the server says so.
 */
export function ApproveDialog({
  snapshot,
  current,
  onClose,
  onApproved,
  onRefresh,
}: {
  snapshot: ApproveSnapshot | null;
  /** The latest polled view; a difference from the snapshot means the answers changed. */
  current: HoldView;
  onClose: () => void;
  onApproved: () => void;
  /** The server refused because the RFI changed: refetch and re-render, keep this dialog's notice. */
  onRefresh: () => void;
}) {
  const titleId = useId();
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [showHash, setShowHash] = useState(false);

  useEffect(() => {
    if (snapshot) {
      setOutcome({ kind: "idle" });
      setShowHash(false);
    }
  }, [snapshot]);

  const open = snapshot !== null;
  const drifted =
    snapshot !== null &&
    (current.rfi.airwallex_updated_at !== snapshot.view.rfi.airwallex_updated_at ||
      current.draft?.id !== snapshot.view.draft?.id);
  const changed = drifted || outcome.kind === "changed";
  const pending = outcome.kind === "pending";

  async function confirm() {
    if (!snapshot || pending || changed) return;
    setOutcome({ kind: "pending" });
    try {
      const res = await fetch(`/api/v1/rfis/${snapshot.view.rfi.id}/approvals`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": snapshot.key },
        body: JSON.stringify(snapshot.body),
      });
      if (res.ok) {
        onApproved();
        return;
      }
      const problem = (await res.json().catch(() => null)) as { message?: string } | null;
      if (res.status === 409) {
        setOutcome({ kind: "changed" });
        onRefresh(); // the screen re-renders from the server's current state
        return;
      }
      setOutcome({ kind: "error", message: problem?.message ?? "" });
    } catch {
      setOutcome({ kind: "error", message: "" });
    }
  }

  const view = snapshot?.view;
  const count = snapshot?.body.answers.length ?? 0;
  const unverified = view ? unverifiedStatements(view) : [];

  return (
    <Modal open={open} onClose={onClose} titleId={titleId} dismissible={!pending}>
      {snapshot && view ? (
        <div className="flex flex-col gap-4 p-4 md:p-6" data-testid="approve-dialog">
          <div className="flex flex-col gap-1">
            <h2
              id={titleId}
              tabIndex={-1}
              className="text-xl leading-tight font-semibold outline-none"
            >
              {t.hold.dialog.title}
            </h2>
            <p className="text-sm text-muted-foreground">{t.hold.dialog.body}</p>
            <p className="text-xs text-muted-foreground">
              {fill(t.hold.dialog.rfi, {
                id: shortId(view.rfi.airwallex_rfi_id),
                round: view.rfi.round,
              })}
            </p>
          </div>
          <ol
            className="flex flex-col gap-3"
            aria-label={t.hold.dialog.title}
            data-testid="dialog-answers"
          >
            {view.questions.map((q, i) => (
              <li key={q.id} className="flex flex-col gap-1 rounded-md border border-border p-3">
                <p className="text-sm font-semibold">
                  {fill(t.hold.dialog.question, { position: i + 1, title: q.title })}
                </p>
                {q.answer_type === "ATTACHMENT" ? (
                  <ul className="text-sm">
                    {(q.answer?.documents ?? []).map((d) => (
                      <li key={d.id} className="break-all">
                        {d.filename}
                        <span className="block font-mono text-xs text-muted-foreground">
                          {fill(t.hold.source.sha, { prefix: d.sha256.slice(0, 16) })}
                          {` ${formatBytes(d.size)}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm break-words" data-testid="dialog-answer-text">
                    {q.answer?.text ?? t.hold.dialog.noAnswer}
                  </p>
                )}
              </li>
            ))}
          </ol>
          {unverified.length > 0 ? (
            <section className="rounded-md border border-border bg-status-warning-bg p-3 text-sm text-status-warning-fg">
              <p className="font-semibold">{t.hold.dialog.yourStatements}</p>
              <ul className="list-disc pl-5">
                {unverified.map((u) => (
                  <li key={u.position}>
                    {fill(t.hold.dialog.question, { position: u.position, title: u.text })}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <p className="font-mono break-all" data-testid="dialog-draft">
              {fill(t.hold.dialog.draft, {
                id: shortId(snapshot.body.draft_id),
                prompt: snapshot.body.prompt_version,
              })}
            </p>
            <button
              type="button"
              aria-expanded={showHash}
              onClick={() => setShowHash((v) => !v)}
              className="min-h-11 w-fit rounded-sm font-medium text-primary underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-focus-ring md:min-h-6"
            >
              {t.hold.dialog.expandHash}
            </button>
            {showHash ? (
              <ul className="font-mono break-all" data-testid="dialog-bound">
                <li>{snapshot.body.rfi_updated_at}</li>
                {snapshot.body.answers.flatMap((a) =>
                  a.fact_version_ids.map((f) => <li key={`${a.question_id}-${f}`}>{f}</li>),
                )}
              </ul>
            ) : null}
          </div>
          <p className="text-sm">{t.hold.dialog.boundNotice}</p>
          {changed ? (
            <p
              role="alert"
              data-testid="dialog-changed"
              className="rounded-md bg-status-danger-bg p-3 text-sm text-status-danger-fg"
            >
              {t.hold.dialog.hashMismatch}
            </p>
          ) : null}
          {outcome.kind === "error" ? (
            <p
              role="alert"
              className="rounded-md bg-status-danger-bg p-3 text-sm text-status-danger-fg"
            >
              {fill(t.hold.dialog.error, { message: outcome.message })}
            </p>
          ) : null}
          {pending ? (
            <p className="text-xs text-muted-foreground">{t.hold.dialog.pendingNoEsc}</p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={pending}>
              {t.hold.dialog.cancel}
            </Button>
            <Button
              onClick={() => void confirm()}
              aria-busy={pending}
              disabled={pending || changed}
            >
              {pending ? t.hold.approval.ctaPending : fill(t.hold.dialog.confirmCount, { count })}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
