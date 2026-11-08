// The public payee status page as a plain HTML document (M3-06): no script, no cookie, no external
// request, no framework chrome. It carries a status word and a time, nothing else: no amount,
// currency, name, reference, bank detail, RFI, document, business or id. Styles are inline, from the
// Carnet tokens (light and dark), so the page needs nothing from the network.
import type { PayeeStatus } from "@carnet/domain";
import { t } from "../strings";

const STATUS_WORD: Record<PayeeStatus, string> = {
  PROCESSING: t.payee.public.processing,
  SENT: t.payee.public.sent,
  PAID: t.payee.public.paid,
  FAILED: t.payee.public.failed,
  DELAYED_FOR_VERIFICATION: t.payee.public.delayed,
};

// Status colours from app/tokens.css; each pair is contrast-verified there (design:contrast).
const STATUS_TONE: Record<PayeeStatus, "progress" | "success" | "danger" | "warning"> = {
  PROCESSING: "progress",
  SENT: "progress",
  PAID: "success",
  FAILED: "danger",
  DELAYED_FOR_VERIFICATION: "warning",
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const CSS = `
:root{color-scheme:light dark;--bg:#fbfaf7;--fg:#1c1f24;--card:#fff;--muted:#585d66;--border:#868b94;
--progress-fg:#1a4f8b;--progress-bg:#e3edf8;--success-fg:#1d6b4f;--success-bg:#e2f2ea;
--danger-fg:#a1261b;--danger-bg:#fbe6e3;--warning-fg:#7f4500;--warning-bg:#fcefd9}
@media (prefers-color-scheme:dark){:root{--bg:#12151a;--fg:#e7e9ec;--card:#1a1e24;--muted:#a3a9b2;--border:#737a85;
--progress-fg:#9cc4f2;--progress-bg:#16263b;--success-fg:#7fd3ae;--success-bg:#12291f;
--danger-fg:#f4a097;--danger-bg:#33171a;--warning-fg:#f2c46b;--warning-bg:#2e2210}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;background:var(--bg);color:var(--fg);
font:16px/1.5 "IBM Plex Sans","Segoe UI",system-ui,-apple-system,"Noto Sans",sans-serif}
main{max-width:32rem;margin:0 auto;padding:2.5rem 1rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:1.5rem}
h1{margin:0 0 1rem;font-size:1.375rem;line-height:1.25;font-weight:600}
dl{margin:0}dt{color:var(--muted);font-size:.875rem}dd{margin:.25rem 0 1rem}
.word{display:inline-block;padding:.25rem .75rem;border-radius:6px;font-weight:600}
.progress{background:var(--progress-bg);color:var(--progress-fg)}
.success{background:var(--success-bg);color:var(--success-fg)}
.danger{background:var(--danger-bg);color:var(--danger-fg)}
.warning{background:var(--warning-bg);color:var(--warning-fg)}
p{margin:0 0 .75rem}.note{color:var(--muted);font-size:.875rem;margin:1rem 0 0}
@media (min-width:768px){h1{font-size:1.75rem}main{padding-top:4rem}}
`
  .replaceAll(/\s*\n\s*/g, "")
  .trim();

function document(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head>
<body><main id="main"><div class="card">${body}</div></main></body></html>`;
}

const UPDATED_FORMAT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/** `6 Nov 2026, 14:03 UTC`. */
export function formatUpdated(date: Date): string {
  return `${UPDATED_FORMAT.format(date)} UTC`;
}

export function renderStatusPage(status: PayeeStatus, updatedAt: Date): string {
  const p = t.payee.public;
  const tone = STATUS_TONE[status];
  return document(
    p.title,
    `<h1>${escapeHtml(p.heading)}</h1>
<dl><dt>${escapeHtml(p.statusLabel)}</dt>
<dd><span class="word ${tone}">${escapeHtml(STATUS_WORD[status])}</span></dd>
<dt>${escapeHtml(p.updatedLabel)}</dt>
<dd><time datetime="${updatedAt.toISOString()}">${escapeHtml(formatUpdated(updatedAt))}</time></dd></dl>
<p class="note">${escapeHtml(p.footnote)}</p>`,
  );
}

function message(title: string, body: string): string {
  return document(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>`);
}

/** The one body for an unknown, expired and revoked link. */
export const renderUnavailable = () =>
  message(t.payee.public.unavailableTitle, t.payee.public.unavailableBody);
export const renderLimited = () => message(t.payee.public.limitedTitle, t.payee.public.limitedBody);
export const renderError = () => message(t.payee.public.errorTitle, t.payee.public.errorBody);
