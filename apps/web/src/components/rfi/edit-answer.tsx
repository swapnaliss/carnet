"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type { DocumentDto, HoldView, QuestionDto } from "@/server/hold";
import { fill, t } from "@/strings";
import { formatBytes } from "./view";

export type EditMode = "edit" | "write" | "attach";

const SENDABLE = new Set(["application/pdf", "image/jpeg"]);

/** The answers of a new owner draft: what the view shows, with this one question replaced. */
export function ownerDraftBody(
  view: HoldView,
  change: {
    questionId: string;
    text: string;
    documentIds: readonly string[];
    ownerAuthored: boolean;
    keepCitations: boolean;
  },
) {
  return {
    parent_draft_id: view.draft?.id ?? null,
    answers: view.questions.flatMap((q) => {
      if (q.id === change.questionId) {
        return [
          {
            question_id: q.id,
            text: change.text,
            document_ids: [...change.documentIds],
            fact_version_ids: change.keepCitations
              ? (q.answer?.citations.map((c) => c.fact_version_id) ?? [])
              : [],
            owner_authored: change.ownerAuthored,
          },
        ];
      }
      const a = q.answer;
      if (!a || (a.status === "NEEDS_OWNER" && a.text === "" && a.documents.length === 0))
        return [];
      return [
        {
          question_id: q.id,
          text: a.text,
          document_ids: a.documents.map((d) => d.id),
          fact_version_ids: a.citations.map((c) => c.fact_version_id),
          owner_authored: a.status === "OWNER_AUTHORED",
        },
      ];
    }),
  };
}

export function EditAnswer({
  view,
  question,
  mode,
  onDone,
  onCancel,
}: {
  view: HoldView;
  question: QuestionDto;
  mode: EditMode;
  /** Called after the server stored the new draft; the caller refetches the view. */
  onDone: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const attachment = question.answer_type === "ATTACHMENT";
  const [text, setText] = useState(question.answer?.text ?? "");
  const [picked, setPicked] = useState<string[]>(question.answer?.documents.map((d) => d.id) ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty =
    text !== (question.answer?.text ?? "") ||
    picked.join() !== (question.answer?.documents.map((d) => d.id) ?? []).join();

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const body = ownerDraftBody(view, {
        questionId: question.id,
        text: attachment ? "" : text,
        documentIds: attachment ? picked : [],
        ownerAuthored: !attachment && mode !== "edit",
        keepCitations: mode === "edit" && !attachment,
      });
      const res = await fetch(`/api/v1/rfis/${view.rfi.id}/drafts`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const problem = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(problem?.message ?? t.hold.edit.error);
        return;
      }
      onDone();
    } catch {
      setError(t.hold.edit.error);
    } finally {
      setSaving(false);
    }
  }

  const docs: readonly DocumentDto[] = view.documents;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      aria-busy={saving}
    >
      {attachment ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t.hold.answer.attachListLabel}</legend>
          {docs.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.hold.answer.attachNone}</p>
          ) : null}
          <ul className="flex flex-col gap-1">
            {docs.map((d) => {
              const sendable = SENDABLE.has(d.mime);
              const inputId = `${id}-${d.id}`;
              return (
                <li key={d.id}>
                  <label
                    htmlFor={inputId}
                    className="flex min-h-11 items-start gap-3 rounded-md border border-border p-2 text-sm md:min-h-9"
                  >
                    <input
                      id={inputId}
                      type="checkbox"
                      className="mt-0.5 size-5 accent-primary"
                      disabled={!sendable || saving}
                      checked={picked.includes(d.id)}
                      onChange={(e) =>
                        setPicked((cur) =>
                          e.target.checked ? [...cur, d.id] : cur.filter((x) => x !== d.id),
                        )
                      }
                    />
                    <span className="flex flex-col">
                      <span className="break-all font-medium">{d.filename}</span>
                      <span className="text-xs text-muted-foreground">
                        {sendable
                          ? fill(t.hold.attachments.file, {
                              name: d.kind,
                              kind: d.mime,
                              size: formatBytes(d.size),
                              prefix: d.sha256.slice(0, 8),
                            })
                          : t.hold.answer.attachNotSendable}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">{t.hold.answer.uploadHint}</p>
        </fieldset>
      ) : (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="text-sm font-medium">
            {mode === "edit" ? t.hold.edit.label : t.hold.answer.writeLabel}
          </label>
          <textarea
            id={id}
            value={text}
            rows={5}
            maxLength={1500}
            disabled={saving}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                void save();
              }
            }}
            aria-describedby={`${id}-hint`}
            className="min-h-28 w-full rounded-md border border-input bg-background p-3 text-base leading-normal outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {mode === "write" ? t.hold.answer.writeHint : t.hold.edit.hint}
          </p>
        </div>
      )}
      {dirty ? <p className="text-xs text-muted-foreground">{t.hold.edit.unsaved}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-status-danger-fg">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={
            saving || (!attachment && text.trim() === "") || (attachment && picked.length === 0)
          }
        >
          {saving ? t.hold.edit.saving : attachment ? t.hold.answer.attachSave : t.hold.edit.save}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          {t.hold.edit.cancel}
        </Button>
      </div>
    </form>
  );
}
