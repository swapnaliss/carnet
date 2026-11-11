"use client";

import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  FileText,
  LoaderCircle,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  UserCheck,
} from "lucide-react";
import Link from "next/link";
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { announce } from "@/components/payments/announce";
import { describeStatus, formatWire } from "@/components/payments/format";
import { LiveIndicator, StaleBanner } from "@/components/payments/live-status";
import { StatusBadge } from "@/components/payments/status-badge";
import { STALE_AFTER_MS, useNow, usePoll } from "@/components/payments/use-poll";
import { Button } from "@/components/ui/button";
import { fieldClass } from "@/components/ui/field";
import { cn } from "@/lib/utils";
import type { EvidenceCheckDto, EvidenceDocumentDto, FactDto, RuleDto } from "@/server/evidence";
import type { PaymentDetailResponse, PaymentDto } from "@/server/payments";
import { fill, t } from "@/strings";
import { EvidenceStrength } from "./evidence-strength";

// The evidence view (M2-03, docs/design/screens/evidence-view.md): for one payment, which documents
// support it, what Carnet extracted (each fact beside its verbatim quote and page), which checks passed
// or failed, and what the owner must do. The flag is computed by code on the server; this component only
// shows it. Every number on screen is a server response: nothing is optimistic.

const card = "flex flex-col gap-4 rounded-md border border-border bg-card p-4 md:p-6";
const field = fieldClass;
const TABS = ["checks", "documents"] as const;
type Tab = (typeof TABS)[number];

const RULE_LABEL: Record<string, string> = {
  "R-AMT": t.evidence.rule.amount,
  "R-PAYEE": t.evidence.rule.payee,
  "R-CONTRACT": t.evidence.rule.contract,
  "R-VERIFIED": t.evidence.rule.verified,
  "R-CONSISTENT": t.evidence.rule.consistent,
};

interface ApiProblem {
  readonly code: string;
  readonly message: string;
  readonly details?: { reason?: string; check?: EvidenceCheckDto };
}

async function problemOf(res: Response): Promise<ApiProblem> {
  const body = (await res.json().catch(() => null)) as { error?: ApiProblem } | null;
  return body?.error ?? { code: "INTERNAL", message: "" };
}

const humanize = (key: string) => {
  const text = key.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** A fact key can repeat within one document (two line items): number the repeats for React. */
function factKeys(facts: readonly FactDto[]): [string, FactDto][] {
  const seen = new Map<string, number>();
  return facts.map((f) => {
    const n = (seen.get(f.key) ?? 0) + 1;
    seen.set(f.key, n);
    return [`${f.key}#${n}`, f];
  });
}

const shortHash = (hash: string) => hash.slice(0, 12);
const formatSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// ---------------------------------------------------------------------------------------------
// Checks

function Outcome({ outcome }: { outcome: RuleDto["outcome"] }) {
  const map = {
    pass: { Icon: CircleCheck, label: t.evidence.check.passed, tone: "text-status-success-fg" },
    fail: { Icon: CircleAlert, label: t.evidence.check.failed, tone: "text-status-danger-fg" },
    missing: {
      Icon: CircleHelp,
      label: t.evidence.check.notChecked,
      tone: "text-status-warning-fg",
    },
  } as const;
  const { Icon, label, tone } = map[outcome];
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-medium", tone)}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {label}
    </span>
  );
}

interface CheckRow {
  readonly id: string;
  readonly label: string;
  readonly outcome: RuleDto["outcome"] | "not_run";
  readonly reasons: readonly {
    key: string;
    text: string;
    params: Readonly<Record<string, string>>;
  }[];
}

const TOTALS = new Set(["totalsAgree", "totalsDiffer"]);
const ACCOUNTS = new Set(["accountsAgree", "accountsDiffer"]);

/** The rule results as the design's check list; R-CONSISTENT is shown as its two comparisons. */
function checkRows(rules: readonly RuleDto[]): CheckRow[] {
  const rows: CheckRow[] = [];
  for (const rule of rules) {
    if (rule.rule !== "R-CONSISTENT") {
      rows.push({
        id: rule.rule,
        label: RULE_LABEL[rule.rule] ?? rule.rule,
        outcome: rule.outcome,
        reasons: rule.reasons,
      });
      continue;
    }
    for (const [id, label, keys, bad] of [
      ["R-CONSISTENT-PO", t.evidence.rule.invoiceMatchesPo, TOTALS, "totalsDiffer"],
      [
        "R-CONSISTENT-ACCOUNT",
        t.evidence.rule.beneficiaryMatchesContract,
        ACCOUNTS,
        "accountsDiffer",
      ],
    ] as const) {
      const reasons = rule.reasons.filter((r) => keys.has(r.key));
      if (reasons.length === 0) continue;
      rows.push({
        id,
        label,
        outcome: reasons.some((r) => r.key === bad) ? "fail" : "pass",
        reasons,
      });
    }
  }
  for (const label of [t.evidence.ruleExtra.contractInForce, t.evidence.ruleExtra.fundsEvidence]) {
    rows.push({
      id: label,
      label,
      outcome: "not_run",
      reasons: [{ key: "notRun", text: t.evidence.notRun, params: {} }],
    });
  }
  return rows;
}

function ChecksPanel({
  data,
  onCite,
}: {
  data: EvidenceCheckDto;
  onCite: (filename: string) => void;
}) {
  const threshold = formatWire(data.contract_threshold);
  const rows = checkRows(data.rules);
  return (
    <div className="flex flex-col gap-4" data-testid="checks-panel">
      {data.rules.length === 0 ? (
        <p className="text-muted-foreground">{t.evidence.check.none}</p>
      ) : null}
      <div className="overflow-hidden rounded-md border border-border bg-card">
        <table className="w-full text-sm">
          <caption className="sr-only">{t.evidence.check.caption}</caption>
          <thead className="hidden border-b border-border bg-muted text-left text-xs font-medium text-muted-foreground md:table-header-group">
            <tr>
              <th scope="col" className="px-4 py-3">
                {t.evidence.check.check}
              </th>
              <th scope="col" className="px-4 py-3">
                {t.evidence.check.result}
              </th>
              <th scope="col" className="px-4 py-3">
                {t.evidence.check.detail}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                data-rule={row.id}
                data-outcome={row.outcome}
                className="block border-b border-border last:border-b-0 md:table-row"
              >
                <th
                  scope="row"
                  className="block px-4 pt-3 text-left font-medium md:table-cell md:py-3"
                >
                  {row.label}
                </th>
                <td className="block px-4 pt-1 md:table-cell md:py-3">
                  <Outcome outcome={row.outcome === "not_run" ? "missing" : row.outcome} />
                </td>
                <td className="block px-4 pt-1 pb-3 md:table-cell md:py-3">
                  <ul className="flex flex-col gap-1">
                    {row.reasons.map((r) => (
                      <li key={`${r.key}-${r.text}`} className="max-w-[70ch]">
                        {r.text}
                        {r.params.document ? (
                          <span className="mt-1 block">
                            <button
                              type="button"
                              onClick={() => onCite(r.params.document ?? "")}
                              className="inline-flex min-h-6 items-center gap-1 rounded-sm border border-border bg-muted px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                            >
                              <FileText aria-hidden="true" className="size-3" />
                              {r.params.document}
                              {r.params.page
                                ? ` \u00b7 ${fill(t.evidence.citation.page, { page: r.params.page })}`
                                : ""}
                            </button>
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.contract_required ? (
        <p className="text-sm text-muted-foreground">
          {fill(t.evidence.check.contractNote, { threshold })}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Documents

const FACT_STATUS = {
  verified: { Icon: CircleCheck, label: t.evidence.fact.verified, tone: "text-status-success-fg" },
  confirmed: {
    Icon: UserCheck,
    label: t.evidence.fact.confirmedByYou,
    tone: "text-status-success-fg",
  },
  needs_confirmation: {
    Icon: UserCheck,
    label: t.evidence.fact.needsConfirmation,
    tone: "text-status-warning-fg",
  },
  unverified: {
    Icon: TriangleAlert,
    label: t.evidence.fact.unverified,
    tone: "text-status-warning-fg",
  },
} as const;

function FactRow({
  fact,
  ticked,
  onTick,
  confirmable,
  textLayer,
}: {
  textLayer: boolean | null;
  fact: FactDto;
  ticked: boolean;
  onTick: (key: string, on: boolean) => void;
  confirmable: boolean;
}) {
  const status = FACT_STATUS[fact.status];
  const name = humanize(fact.key);
  return (
    <li
      data-fact={fact.key}
      data-status={fact.status}
      className="grid gap-2 border-b border-border px-4 py-3 last:border-b-0 xl:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1.4fr)_11rem] xl:gap-4"
    >
      <div className="flex items-start gap-2 font-medium">
        {confirmable && fact.status === "needs_confirmation" ? (
          <input
            type="checkbox"
            checked={ticked}
            onChange={(e) => onTick(fact.key, e.target.checked)}
            aria-label={fill(t.evidence.fact.confirmLabel, { field: name, value: fact.value })}
            className="mt-0.5 size-5 shrink-0 accent-primary"
          />
        ) : null}
        <span>{name}</span>
      </div>
      <div className="min-w-0 break-words" data-testid="fact-value">
        {fact.value}
      </div>
      <div className="min-w-0 text-sm text-muted-foreground">
        {fact.quote ? (
          <blockquote className="rounded-sm border-l-2 border-border bg-muted px-3 py-2 text-foreground">
            <span className="break-words">{fact.quote}</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {fill(t.evidence.fact.page, { page: fact.page })}
            </span>
          </blockquote>
        ) : (
          <span>{textLayer === false ? t.evidence.fact.scanNoQuote : t.evidence.fact.noQuote}</span>
        )}
      </div>
      <div className={cn("flex items-start gap-1.5 text-sm font-medium", status.tone)}>
        <status.Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {status.label}
      </div>
    </li>
  );
}

function DocumentCard({
  doc,
  canEdit,
  onChanged,
  onRemove,
}: {
  doc: EvidenceDocumentDto;
  canEdit: boolean;
  onChanged: () => Promise<void>;
  onRemove: (doc: EvidenceDocumentDto) => Promise<void>;
}) {
  const titleId = useId();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toConfirm = doc.facts.filter((f) => f.status === "needs_confirmation");
  const allTicked = toConfirm.length > 0 && toConfirm.every((f) => ticked.has(f.key));
  const confirmable = canEdit && doc.needs_confirmation && doc.facts_version !== null;

  async function confirm() {
    if (!allTicked || doc.facts_version === null || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/documents/${doc.document_id}/facts/${doc.facts_version}/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) throw new Error(String(res.status));
      announce(t.evidence.fact.confirmDone);
      await onChanged();
    } catch {
      setError(t.evidence.fact.confirmError);
    }
    setPending(false);
  }

  const kind = (t.evidence.documents.kind as Record<string, string>)[doc.kind] ?? doc.kind;
  return (
    <section aria-labelledby={titleId} data-document={doc.document_id} className={card}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={titleId} className="flex items-center gap-2 text-base font-semibold break-all">
            <FileText aria-hidden="true" className="size-4 shrink-0" />
            {doc.filename}
          </h3>
          <p className="text-sm text-muted-foreground">
            {fill(t.evidence.documents.meta, {
              kind,
              size: formatSize(doc.size),
              hash: shortHash(doc.sha256),
            })}
            {doc.text_layer === false ? ` · ${t.evidence.documents.textLayerNo}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <a href={`/api/v1/documents/${doc.document_id}`} download>
              {t.evidence.documents.open}
            </a>
          </Button>
          {canEdit ? (
            <Button
              variant="outline"
              size="sm"
              aria-label={fill(t.evidence.documents.removeLabel, { name: doc.filename })}
              onClick={() => void onRemove(doc)}
            >
              <Trash2 aria-hidden="true" />
              {t.evidence.documents.remove}
            </Button>
          ) : null}
        </div>
      </div>

      {doc.injection_flags.length > 0 ? (
        <div
          role="status"
          className="flex gap-3 rounded-md border border-border bg-status-warning-bg p-3 text-status-warning-fg"
        >
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-semibold">{t.evidence.injection.title}</p>
            <p>
              {fill(t.evidence.injection.body, {
                match: doc.injection_flags.map((f) => `“${f.match}”`).join(", "),
              })}
            </p>
          </div>
        </div>
      ) : null}

      {doc.extraction === "pending" ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle
            aria-hidden="true"
            className="size-4 animate-pulse motion-reduce:animate-none"
          />
          {t.evidence.documents.reading}
        </p>
      ) : doc.extraction === "failed" ? (
        <p className="flex items-start gap-2 text-sm text-status-danger-fg">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{t.evidence.documents.readFailedWhy}</span>
        </p>
      ) : doc.extraction === "none" ? (
        <p className="text-sm text-muted-foreground">{t.evidence.documents.unreadableKind}</p>
      ) : doc.facts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.evidence.documents.noFacts}</p>
      ) : (
        <>
          {confirmable ? (
            <div className="flex flex-col gap-1 rounded-md bg-muted p-3 text-sm">
              <p className="font-semibold">{t.evidence.fact.confirmGroup}</p>
              <p className="max-w-[70ch] text-muted-foreground">{t.evidence.fact.confirmHint}</p>
            </div>
          ) : null}
          <div className="overflow-hidden rounded-md border border-border">
            <div className="hidden grid-cols-[10rem_minmax(0,1fr)_minmax(0,1.4fr)_11rem] gap-4 border-b border-border bg-muted px-4 py-2 text-xs font-medium text-muted-foreground xl:grid">
              <span>{t.evidence.fact.field}</span>
              <span>{t.evidence.fact.value}</span>
              <span>{t.evidence.fact.source}</span>
              <span>{t.evidence.fact.status}</span>
            </div>
            <ul>
              {factKeys(doc.facts).map(([rowKey, f]) => (
                <FactRow
                  key={rowKey}
                  fact={f}
                  confirmable={confirmable}
                  textLayer={doc.text_layer}
                  ticked={ticked.has(f.key)}
                  onTick={(key, on) =>
                    setTicked((prev) => {
                      const next = new Set(prev);
                      if (on) next.add(key);
                      else next.delete(key);
                      return next;
                    })
                  }
                />
              ))}
            </ul>
          </div>
          {confirmable ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void confirm()} disabled={!allTicked || pending}>
                {pending
                  ? t.evidence.fact.confirmCtaPending
                  : toConfirm.length === 1
                    ? t.evidence.fact.confirmCtaOne
                    : fill(t.evidence.fact.confirmCta, { count: toConfirm.length })}
              </Button>
              <span className="text-sm text-muted-foreground">
                {allTicked
                  ? null
                  : fill(t.evidence.fact.allTicked, {
                      ticked: toConfirm.filter((f) => ticked.has(f.key)).length,
                      count: toConfirm.length,
                    })}
              </span>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
              <CircleAlert aria-hidden="true" className="size-4" />
              {error}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

const KINDS = ["invoice", "contract", "purchase_order", "statement", "other"] as const;

function AddDocument({
  paymentId,
  onAdded,
  secondary,
}: {
  paymentId: string;
  onAdded: (m: string) => Promise<void>;
  /** Documents are already linked: the form waits behind a button. */
  secondary: boolean;
}) {
  const ids = useId();
  const [open, setOpen] = useState(!secondary);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError(t.evidence.add.errorChoose);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const upload = new FormData();
      upload.set("kind", String(new FormData(form).get("kind") ?? "other"));
      upload.set("file", file);
      const up = await fetch("/api/v1/documents", { method: "POST", body: upload });
      const meta = (await up.json().catch(() => null)) as {
        id?: string;
        filename?: string;
        deduplicated?: boolean;
        error?: { message?: string };
      } | null;
      if (!up.ok || !meta?.id) {
        setError(meta?.error?.message ?? t.evidence.add.errorGeneric);
        setPending(false);
        return;
      }
      const link = await fetch(`/api/v1/payments/${paymentId}/evidence-links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document_id: meta.id }),
      });
      if (!link.ok) throw new Error(String(link.status));
      form.reset();
      await onAdded(
        fill(meta.deduplicated ? t.evidence.add.doneKnown : t.evidence.add.done, {
          name: meta.filename ?? file.name,
        }),
      );
    } catch {
      setError(t.evidence.add.errorGeneric);
    }
    setPending(false);
  }

  if (!open) {
    return (
      <div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          {t.evidence.add.another}
        </Button>
      </div>
    );
  }
  return (
    <section aria-labelledby={`${ids}-title`} className={card}>
      <div className="flex flex-col gap-1">
        <h3 id={`${ids}-title`} className="text-base font-semibold">
          {t.evidence.add.title}
        </h3>
        <p className="max-w-[65ch] text-sm text-muted-foreground">{t.evidence.add.body}</p>
      </div>
      <form
        onSubmit={submit}
        noValidate
        className="grid gap-4 md:grid-cols-[1fr_14rem_auto] md:items-end"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-file`} className="text-sm font-medium">
            {t.evidence.add.file}
          </label>
          <input
            id={`${ids}-file`}
            ref={fileRef}
            type="file"
            name="file"
            accept="application/pdf,image/png,image/jpeg"
            className={`${field} py-2 file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-kind`} className="text-sm font-medium">
            {t.evidence.add.kind}
          </label>
          <select id={`${ids}-kind`} name="kind" defaultValue="invoice" className={field}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t.evidence.documents.kind[k]}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? t.evidence.add.submitPending : t.evidence.add.submit}
        </Button>
      </form>
      {error ? (
        <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
          <CircleAlert aria-hidden="true" className="size-4" />
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Approve and send

const STEP_ICON = { done: CircleCheck, todo: CircleDashed } as const;

/** What happened to a sent payment, from the stored attempt and transfer (never inferred). */
function SentPanel({ data, payment }: { data: EvidenceCheckDto; payment: PaymentDto }) {
  const ids = useId();
  const a = payment.attempt;
  const confirmed = a?.status === "CONFIRMED" || payment.transfer_id !== null;
  const steps = [
    { label: t.evidence.steps.approved, done: true },
    { label: t.evidence.steps.sent, done: Boolean(a?.sent_at) || confirmed },
    {
      label: confirmed ? t.evidence.steps.confirmed : t.evidence.steps.confirming,
      done: confirmed,
    },
  ];
  return (
    <section aria-labelledby={`${ids}-title`} className={card} data-testid="send-panel">
      <h2 id={`${ids}-title`} className="text-lg leading-tight font-semibold">
        {confirmed ? t.evidence.send.sentTitleConfirmed : t.evidence.send.sentTitle}
      </h2>
      <ol className="flex flex-col gap-2" aria-label={t.evidence.steps.title}>
        {steps.map((step) => {
          const Icon = STEP_ICON[step.done ? "done" : "todo"];
          return (
            <li key={step.label} className="flex items-center gap-2">
              <Icon
                aria-hidden="true"
                className={cn(
                  "size-5",
                  step.done ? "text-status-success-fg" : "text-muted-foreground",
                )}
              />
              {step.label}
            </li>
          );
        })}
      </ol>
      <p className="text-muted-foreground">{t.evidence.send.sentBody}</p>
      <div>
        <Button asChild variant="outline">
          <Link href={`/payments/${data.payment.id}`}>{t.evidence.send.sentLink}</Link>
        </Button>
      </div>
    </section>
  );
}

/**
 * The payout approval (docs/design/screens/evidence-view.md): a modal that shows what Carnet will send,
 * and, when the evidence is not strong, the acknowledgement the server requires. Values Airwallex
 * decides later (fee, value date) say so instead of showing a made-up figure.
 */
function ApproveDialog({
  data,
  onClose,
  onSent,
  onStale,
}: {
  data: EvidenceCheckDto;
  onClose: () => void;
  onSent: () => Promise<void>;
  onStale: (check: EvidenceCheckDto) => void;
}) {
  const ids = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [ack, setAck] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const strong = data.flag === "strong";

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  // A new check (documents changed) clears the acknowledgement: it was for the reasons that were shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the hash is the trigger
  useEffect(() => setAck(false), [data.check_hash]);

  async function send() {
    if (pending) return;
    if (!strong && !ack) {
      setError(t.evidence.send.needsAck);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/payments/${data.payment.id}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          strong ? {} : { evidence_ack: { acknowledged: true, check_hash: data.check_hash } },
        ),
      });
      if (res.ok) {
        announce(t.evidence.send.done);
        await onSent();
        onClose();
        return;
      }
      const problem = await problemOf(res);
      if (problem.details?.check) {
        onStale(problem.details.check);
        setError(t.evidence.send.errorChanged);
      } else if (problem.code === "PRECONDITION_FAILED" && problem.message) {
        setError(fill(t.evidence.send.errorFunds, { message: problem.message }));
      } else {
        setError(t.evidence.send.errorGeneric);
      }
    } catch {
      setError(t.evidence.send.errorGeneric);
    }
    setPending(false);
  }

  const rows: [string, string][] = [
    [
      t.evidence.approve.payTo,
      `${data.payment.counterparty_name ?? t.queue.unnamedPayee} (${data.payment.method})`,
    ],
    [
      t.evidence.approve.account,
      data.payment.account_fingerprint ?? t.evidence.summary.accountNone,
    ],
    [t.evidence.approve.amount, formatWire(data.payment.amount)],
    [
      t.evidence.approve.source,
      fill(t.evidence.approve.sourceValue, { currency: data.payment.amount.currency }),
    ],
    [t.evidence.approve.fee, t.evidence.approve.feeValue],
    [t.evidence.approve.valueDate, t.evidence.approve.valueDateValue],
    [t.evidence.approve.reference, data.payment.reference],
  ];
  return (
    <dialog
      ref={ref}
      aria-labelledby={`${ids}-title`}
      onClose={onClose}
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-md border border-border bg-card p-0 text-foreground shadow-3 backdrop:bg-black/50"
      data-testid="approve-dialog"
    >
      <div className="flex flex-col gap-4 p-4 md:p-6">
        <h2 id={`${ids}-title`} className="text-lg leading-tight font-semibold">
          {t.evidence.approve.title}
        </h2>
        <p className="text-sm text-muted-foreground">{t.evidence.approve.body}</p>
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 break-words font-medium">{v}</dd>
            </div>
          ))}
        </dl>
        <EvidenceStrength flag={data.flag} size="md" className="w-fit" />
        {strong ? null : (
          <>
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              {data.reasons.map((r) => (
                <li key={`${r.key}-${r.text}`}>{r.text}</li>
              ))}
            </ul>
            <div className="flex items-start gap-3">
              <input
                id={`${ids}-ack`}
                type="checkbox"
                checked={ack}
                onChange={(e) => {
                  setAck(e.target.checked);
                  setError(null);
                }}
                className="mt-0.5 size-5 shrink-0 accent-primary"
              />
              <label htmlFor={`${ids}-ack`} className="max-w-[65ch] text-sm font-medium">
                {t.evidence.send.ackLabel}
              </label>
            </div>
          </>
        )}
        {error ? (
          <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
            <CircleAlert aria-hidden="true" className="size-4" />
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-3">
          <Button variant="outline" onClick={onClose}>
            {t.evidence.approve.cancel}
          </Button>
          <Button onClick={() => void send()} disabled={pending}>
            {pending
              ? t.evidence.send.ctaPending
              : strong
                ? t.evidence.send.cta
                : t.evidence.send.ctaAcknowledge}
          </Button>
        </div>
      </div>
    </dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// The view

export function EvidenceView({
  initial,
  initialPayment,
  canEdit,
}: {
  initial: EvidenceCheckDto;
  initialPayment: PaymentDetailResponse;
  canEdit: boolean;
}) {
  const id = initial.payment.id;
  const [data, setData] = useState(initial);
  const [payment, setPayment] = useState(initialPayment.payment);
  const [tab, setTab] = useState<Tab>(initial.documents.length === 0 ? "documents" : "checks");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const now = useNow();
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ checks: null, documents: null });
  const pending = data.documents.some((d) => d.extraction === "pending");
  const poll = usePoll<EvidenceCheckDto>(
    `/api/v1/payments/${id}/evidence-check`,
    initial,
    pending ? 3_000 : 30_000,
  );

  // The poll is the server's latest answer; take it unless a newer local action already replaced it.
  const polled = useRef(poll.lastSuccessAt);
  useEffect(() => {
    if (poll.lastSuccessAt !== polled.current) {
      polled.current = poll.lastSuccessAt;
      setData(poll.data);
    }
  }, [poll.lastSuccessAt, poll.data]);

  // `#checks` / `#documents` in the address select the tab (and back/forward keep working).
  useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.slice(1);
      if ((TABS as readonly string[]).includes(h)) setTab(h as Tab);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [check, detail] = await Promise.all([
        fetch(`/api/v1/payments/${id}/evidence-check`, { cache: "no-store" }),
        fetch(`/api/v1/payments/${id}`, { cache: "no-store" }),
      ]);
      if (!check.ok) throw new Error(String(check.status));
      const next = (await check.json()) as EvidenceCheckDto;
      setData(next);
      if (!next.documents.some((d) => d.extraction === "pending")) setNotice(null);
      if (detail.ok) setPayment(((await detail.json()) as PaymentDetailResponse).payment);
      setError(null);
    } catch {
      setError(t.evidence.error.checks);
    }
  }, [id]);

  async function added(message: string) {
    setNotice(message);
    announce(message);
    await refresh();
    selectTab("documents");
  }

  async function remove(doc: EvidenceDocumentDto) {
    try {
      const res = await fetch(`/api/v1/payments/${id}/evidence-links/${doc.link_id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(String(res.status));
      const message = fill(t.evidence.documents.removed, { name: doc.filename });
      setNotice(message);
      announce(message);
      setData((await res.json()) as EvidenceCheckDto);
    } catch {
      setError(t.evidence.error.documents);
    }
  }

  /** A citation chip jumps to the document it names, in the Documents tab. */
  function cite(filename: string) {
    selectTab("documents");
    const doc = data.documents.find((d) => d.filename === filename);
    setTimeout(() => {
      const el = doc
        ? document.querySelector<HTMLElement>(`[data-document="${doc.document_id}"] h3`)
        : null;
      el?.setAttribute("tabindex", "-1");
      el?.focus();
    }, 0);
  }

  function selectTab(next: Tab, focus = false) {
    setTab(next);
    window.history.replaceState(null, "", `#${next}`);
    if (focus) tabRefs.current[next]?.focus();
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    const at = TABS.indexOf(tab);
    const keys: Record<string, number> = {
      ArrowRight: (at + 1) % TABS.length,
      ArrowLeft: (at + TABS.length - 1) % TABS.length,
      Home: 0,
      End: TABS.length - 1,
    };
    const to = keys[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = TABS[to];
    if (next) selectTab(next, true);
  }

  // "Carnet is reading it" is only true while a document is being read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pending` is the trigger
  useEffect(() => {
    if (!pending) setNotice(null);
  }, [pending]);
  const rows = checkRows(data.rules);
  const checkSummary = {
    total: rows.length,
    notRun: rows.filter((r) => r.outcome === "not_run").length,
  };
  const stale = now - poll.lastSuccessAt > STALE_AFTER_MS;
  const payee = data.payment.counterparty_name ?? t.queue.unnamedPayee;
  const summary =
    data.flag === "strong"
      ? t.evidence.strength.summaryStrong
      : data.flag === "weak"
        ? t.evidence.strength.summaryWeak
        : t.evidence.strength.summaryMissing;

  return (
    <div
      className={cn("flex flex-col gap-6", canEdit && !data.payment.sent && "pb-24 md:pb-0")}
      data-flag={data.flag}
    >
      <Link
        href="/queue"
        className="inline-flex min-h-11 w-fit items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-4 hover:no-underline md:min-h-6"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t.evidence.backToQueue}
      </Link>

      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-xl leading-tight font-semibold md:text-2xl">
            {fill(t.evidence.title, { payee })}
          </h1>
          <p className="text-lg font-semibold tabular-nums">{formatWire(data.payment.amount)}</p>
        </div>
        <dl
          className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4"
          data-testid="payment-summary"
        >
          {(
            [
              [t.payments.list.reference, data.payment.reference],
              [t.evidence.summary.method, data.payment.method],
              [
                t.evidence.summary.account,
                data.payment.account_fingerprint ?? t.evidence.summary.accountNone,
              ],
              [t.evidence.summary.due, t.evidence.summary.dueNone],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="flex flex-col">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="min-w-0 font-medium break-words">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          <EvidenceStrength flag={data.flag} size="md" />
          {checkSummary.notRun > 0 ? (
            <span className="text-sm text-muted-foreground" data-testid="checks-run">
              {fill(t.evidence.strength.checksRun, {
                run: checkSummary.total - checkSummary.notRun,
                total: checkSummary.total,
              })}
            </span>
          ) : null}
          <StatusBadge status={describeStatus(payment)} size="md" />
          <LiveIndicator
            lastSuccessAt={poll.lastSuccessAt}
            failures={poll.failures}
            paused={poll.paused}
            now={now}
          />
        </div>
        {canEdit && !data.payment.sent ? (
          <div
            className={cn(
              "fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 flex flex-col gap-1 border-t border-border bg-card p-3",
              "md:static md:z-auto md:flex-row md:items-center md:gap-3 md:border-0 md:bg-transparent md:p-0",
            )}
          >
            <Button
              className="w-full md:w-auto disabled:border disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
              disabled={stale}
              onClick={() => setApproving(true)}
            >
              {t.evidence.approve.cta}
            </Button>
            {stale ? <p className="text-base text-foreground">{t.evidence.approve.stale}</p> : null}
          </div>
        ) : null}
        {!canEdit && !data.payment.sent ? (
          <p className="text-sm text-muted-foreground">{t.evidence.send.viewerOnly}</p>
        ) : null}
        <div className="flex flex-col gap-2" data-testid="reasons">
          <p className="font-medium">{summary}</p>
          <h2 className="sr-only">{t.evidence.reasonsTitle}</h2>
          <ul className="flex max-w-[70ch] list-disc flex-col gap-1 pl-5 text-sm">
            {data.reasons.map((r) => (
              <li key={`${r.key}-${r.text}`}>{r.text}</li>
            ))}
          </ul>
        </div>
      </header>

      <StaleBanner lastSuccessAt={poll.lastSuccessAt} now={now} onCheckNow={poll.checkNow} />
      {error ? (
        <p role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
          <CircleAlert aria-hidden="true" className="size-4" />
          {error}
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            {t.common.state.retry}
          </Button>
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-status-success-fg" data-testid="notice">
          {notice}
        </p>
      ) : null}

      <div className="flex flex-col gap-4">
        <div
          role="tablist"
          aria-label={t.evidence.tabs.label}
          className="flex gap-1 border-b border-border"
        >
          {TABS.map((name) => (
            <button
              key={name}
              ref={(el) => {
                tabRefs.current[name] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${name}`}
              aria-selected={tab === name}
              aria-controls={`panel-${name}`}
              tabIndex={tab === name ? 0 : -1}
              onClick={() => selectTab(name)}
              onKeyDown={onTabKey}
              className={cn(
                "-mb-px min-h-11 border-b-2 px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-focus-ring md:min-h-10",
                tab === name
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.evidence.tabs[name]}
              {name === "documents" ? ` (${data.documents.length})` : ""}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id="panel-checks"
          aria-labelledby="tab-checks"
          hidden={tab !== "checks"}
        >
          {tab === "checks" ? <ChecksPanel data={data} onCite={cite} /> : null}
        </div>
        <div
          role="tabpanel"
          id="panel-documents"
          aria-labelledby="tab-documents"
          hidden={tab !== "documents"}
        >
          {tab === "documents" ? (
            <div className="flex flex-col gap-4">
              {data.documents.length === 0 ? (
                <div className={card}>
                  <h3 className="text-base font-semibold">{t.evidence.documents.empty.title}</h3>
                  <p className="max-w-[65ch] text-muted-foreground">
                    {t.evidence.documents.empty.body}
                  </p>
                </div>
              ) : (
                data.documents.map((doc) => (
                  <DocumentCard
                    key={doc.document_id}
                    doc={doc}
                    canEdit={canEdit && !data.payment.sent}
                    onChanged={refresh}
                    onRemove={remove}
                  />
                ))
              )}
              {canEdit && !data.payment.sent ? (
                <AddDocument paymentId={id} onAdded={added} secondary={data.documents.length > 0} />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {data.payment.sent ? <SentPanel data={data} payment={payment} /> : null}
      {approving ? (
        <ApproveDialog
          data={data}
          onClose={() => setApproving(false)}
          onSent={refresh}
          onStale={(check) => setData(check)}
        />
      ) : null}
    </div>
  );
}
