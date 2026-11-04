# Components

shadcn components are copied into `apps/web/src/components/ui/` and restyled only through tokens.
Carnet components live in `apps/web/src/components/carnet/`. No component contains a user-facing literal;
every label comes from `strings.ts`.

## shadcn components used

| Component | Variants used | Where | Notes |
|---|---|---|---|
| `Button` | `default` (primary), `secondary`, `outline`, `ghost`, `destructive`, `link`; sizes `sm` (32px, desktop only), `default` (40px), `lg` (44px) | Everywhere | Below 768px every button is at least 44px tall. A `pending` prop (Carnet addition) shows a static spinner icon + pending label, sets `aria-busy`, and disables the button; it never shows a success tick before the server confirms |
| `Badge` | `outline` only, extended by StatusBadge | Status, evidence strength, counts | Never used raw for a status; use StatusBadge |
| `Card` | Header, content, footer | Queue summary, evidence documents, plan actions, ops tiles | Border `--border`, no shadow |
| `Table` | Default, sticky header | Payment queue (≥768px), plan obligations, ops jobs/webhooks/attempts | Rows are `<tr>` with a real link in the first cell; whole-row click is a convenience, not the only target |
| `Dialog` | Default | Bound approval confirmation, payout approval | Focus trapped, returns to the trigger; `Esc` closes only when no request is pending |
| `AlertDialog` | Default | Reject a plan action, discard an edited draft | Requires an explicit choice |
| `Sheet` | `bottom` (mobile), `right` (desktop) | Source document preview on mobile; plan action details | |
| `Alert` | `default`, `destructive`, plus Carnet tones `warning`, `held` | Screen-level messages: replay banner, injection flag, errors | Icon + title + body; `role="status"` or `role="alert"` per `accessibility.md` |
| `Separator` | Horizontal, vertical | Between sections; uses `--divider` | Decorative: `decorative` prop set |
| `Skeleton` | Line, block, table-row | Loading states | Sized to the final content so nothing shifts (CLS) |
| `Tooltip` | Default | Absolute timestamps, shortened ids, status explanations | Supplementary only; anything essential is also visible or in the accessible name. Opens on focus as well as hover |
| `Textarea` | Default, `aria-invalid` | Editing a draft answer, writing a NEEDS_OWNER answer | 16px text; autosize with a max height; character count when Airwallex sets a limit |
| `Label`, `Checkbox`, `RadioGroup` | Default | Approval acknowledgement, attachment choice, payee disclosure level | 24px hit area minimum, 44px below 768px |
| `Tabs` | Default | Evidence view (Documents / Checks), ops (Health / Jobs / Audit) | Arrow keys move between tabs (Radix) |
| `Collapsible` | Default | Answered questions, earlier rounds, error details | |
| `DropdownMenu` | Default | Row overflow actions | Never the only path to a primary action |
| `ScrollArea` | Default | Document preview pane | |
| `Sonner` (toast) | Default | Confirmations of non-money actions only ("Link copied") | **Never** for money, approvals or RFI outcomes: those stay on the page as server-confirmed state |

## Carnet components

### StatusBadge

Shows the payment **projection** (ADR 0006): one Airwallex transfer status, plus a separate held badge
when an RFI is open on a transfer that is `SCHEDULED`, `PROCESSING` or `SENT`. It reads only server
state; it never infers a transfer status from an RFI.

Props: `transferStatus: TransferStatus | null`, `held: boolean`, `failure?: { type, reason }`,
`size?: "sm" | "md"`, `href?` (the reason link).

Anatomy: `[icon] Label` in a 24px-high pill: `--radius-sm`, a solid 1px border in `--border`, fill
`--status-<tone>-bg`, icon and text `--status-<tone>-fg`, `--text-xs` medium weight. Below 768px the pill is 28px high
inside a 44px tap row. When `href` is set, the badge is a link whose accessible name is the full
sentence (for example "Transfer status: Processing. Held for information. View the request.").

| Transfer status | Tone | Icon | Label (`status.transfer.<key>.label`) | Reason line / tooltip (`…hint`) |
|---|---|---|---|---|
| none (not yet created) | neutral | `circle-dashed` | Not sent | "No transfer has been created in Airwallex yet." |
| `IN_APPROVAL` | neutral | `user-check` | In approval | "Waiting for approval in your Airwallex account." |
| `APPROVAL_RECALLED` | neutral | `undo-2` | Approval recalled | "The approval request was withdrawn in Airwallex. Nothing was sent." |
| `APPROVAL_REJECTED` | danger | `octagon-x` | Approval rejected | "An approver in Airwallex rejected this transfer. Nothing was sent." |
| `APPROVAL_BLOCKED` | danger | `ban` | Approval blocked | "Airwallex blocked the approval. Nothing was sent." |
| `SCHEDULED` | progress | `calendar-clock` | Scheduled | "Airwallex has the transfer and will process it on the value date." |
| `OVERDUE` | warning | `triangle-alert` | Overdue | "Past its scheduled date and not yet processed. Airwallex reports it as overdue." |
| `PROCESSING` | progress | `loader-circle` (static) | Processing | "Airwallex is processing the transfer." |
| `SENT` | progress | `send` | Sent, not yet paid | "Airwallex has sent the funds. Sent is not final; it can still fail." |
| `PAID` | success | `circle-check` | Paid | "Airwallex reports the funds as paid. A paid transfer can still be returned." |
| `FAILED` | danger | `octagon-x` | Failed | "Airwallex reports: {failureReason}" (`failure_type` in details) |
| `CANCELLED` with a `failure` object | danger | `octagon-x` | Not sent (failed) | "Airwallex ended this transfer: {failureReason}. This does not mean anyone cancelled it." |
| `CANCELLED` without a failure | neutral | `circle-slash` | Cancelled | "Airwallex reports the transfer as cancelled. Nothing was sent." |
| unrecognised value | neutral | `circle-help` | Unknown status | "Airwallex returned a status Carnet does not know: {raw}." |

**Held flag.** A second badge, rendered immediately before the transfer badge, tone `held`, icon
`circle-pause`, label "Held for information" (`status.held.label`), hint "Airwallex asked for
information about this transfer. Its status above is unchanged." The pair always reads in this order:
`[Held for information] [Processing]`. On the hold screen header the pair is `size="md"`. The held badge
is never shown for `PAID`, `FAILED`, `CANCELLED` or approval statuses (the projection does not set it);
if the server sends `held: true` with such a status, show both badges anyway (server truth) and log a
client warning.

**Incident.** `PAID → FAILED` arrives as `FAILED` with `incident: true`: the badge adds a visible text
suffix "after paid" and the row gets a `danger` left rule.

Status-change highlight: when a polled update changes a badge, the row tints `--accent` for
`--duration-slow` and the change is announced politely (see `accessibility.md`).

### MoneyDisplay

Renders a domain `Money` (`{ amountMinor: bigint | string, currency: string }`) through
`formatMoney(money, locale)` in `lib/intl.ts`.

- Converts minor units to a decimal **string** using the ISO 4217 exponent from the domain currency
  table (JPY 0, USD 2, EUR 2, KWD 3, …). It builds the major-unit string by integer division and
  padding, then formats with `Intl.NumberFormat(locale, { style: "currency", currency,
  currencyDisplay: "code", minimumFractionDigits: e, maximumFractionDigits: e })` using
  `format(decimalString)` (Intl accepts a string numeric value; no `Number()` conversion, no floats).
- Always shows the ISO code (`EUR 7,200.00`, `USD 4,800.00`, `JPY 120,000`); the symbol alone is
  ambiguous across USD/CAD/AUD.
- `tabular-nums`, right-aligned in tables, `whitespace-nowrap` for the amount itself.
- Variants: `default`; `hero` (`--text-2xl`, semibold, hold screen header); `delta` (signed, with an
  explicit `+`/`−` sign and the word "more"/"less" in the accessible name, never colour alone);
  `converted` (two amounts with a `→`, the rate and the fee: "USD 7,890.12 → EUR 7,200.00 · rate
  0.91253 · fee USD 15.00").
- Accessible name is the formatted string; screen readers read "EUR 7,200.00".
- Negative amounts use the minus sign `−` (U+2212) via Intl, not a hyphen.
- An amount from Airwallex that does not parse renders "Amount unavailable" (`money.unavailable`) with
  the raw value in details, never `NaN`.

### CitationChip

A small inline control that ties a claim to its evidence.

- Anatomy: `[file-text icon] inv-rhein-001 · p1` in `--text-xs`, `--radius-sm`, `--muted` fill,
  `--border` outline; the number badge `[1]` form is used inside running text.
- Activating it (click, `Enter`, `Space`) scrolls the matching SourceSnippet into view, highlights it
  (`--accent` fill, 2px `--focus-ring` left rule) and moves focus to the snippet heading. Below 768px it
  opens the snippet in a bottom Sheet instead.
- Linked pair: chip `aria-controls` the snippet id; the snippet lists "Cited by: claim 1, claim 3" with
  links back.
- States: `verified` (quote found on that page by code: `check` icon, label "Quote verified"),
  `owner-confirmed` (image-only document, the owner confirmed the fact: `user-check`, "Confirmed by you"),
  `unverified` (warning tone, `triangle-alert`, "Quote not found"; only appears when the verifier has
  flagged the claim, in which case the question is NEEDS_OWNER).

### SourceSnippet

The verbatim quote that supports a claim, shown beside it.

- Anatomy: header line (document title from the filename and kind: "Invoice RD-2026-1180",
  document id in mono, "page 1 of 1", verification state); the quote in a `<blockquote>` on `--muted`
  with the exact text, the cited span marked with `<mark>` (styled `--accent` fill, underline, not
  colour alone); footer: "Open document" (opens the PDF page in a Sheet/new tab, served as an
  attachment) and the document SHA-256 short form.
- The quote is rendered as text, never as HTML; document text is untrusted data.
- Long quotes are clamped to 4 lines with "Show full quote"; the cited span is always inside the
  visible part.
- If the document is image-only, the snippet shows "No text layer. Fact confirmed by you on 〈date〉."
  plus a thumbnail of the page region if available, with alt text equal to the confirmed fact.

### ApprovalBar

The single place an owner grants a **bound approval** (ADR 0008).

- Position: sticky at the bottom of the hold screen content column (and plan action panel), full width
  of that column, `--shadow-2`, `--card` fill, top border `--border`, height `--approval-bar-height`
  (72px; grows to fit on mobile, respects `env(safe-area-inset-bottom)`).
- Content left: readiness summary, e.g. "3 of 3 questions ready · 1 attachment · content hash
  `9c41…e07a`". When blocked: "1 question needs your answer" as a link to that question.
- Content right: one primary Button. Label states the exact effect: "Approve and submit 3 answers"
  (`hold.approval.ctaCount`).
- States (all server-driven):
  - `blocked`: button disabled (still focusable via `aria-disabled="true"`, so the reason is
    reachable); reason text visible next to it.
  - `ready`: enabled.
  - `confirming`: the approval Dialog is open.
  - `pending`: after confirm; button shows the static spinner and "Submitting to Airwallex…"; `aria-busy`.
  - `approved-waiting`: the server holds an APPROVED approval and an attempt in progress: "Approved by
    you at 14:02. Waiting for Airwallex." with the LiveIndicator.
  - `submitted`: "Answer submitted to Airwallex at 14:02. Transfer still Processing." No button.
  - `invalidated`: the content changed after approval: warning tone, "The answers changed after you
    approved. Approve again." and the button returns to `ready`.
  - `expired`: "Your approval expired before it was used. Approve again."
  - `disabled-by-kill-switch`: "Execution is paused by an operator. Nothing will be sent." Button
    disabled.
- It never shows a success state until the server reports the RFI as `ANSWERED` (see the hold screen
  "No optimistic updates").

### StaleBanner

Shown when data the screen depends on is older than its freshness budget or the last poll failed.

- `Alert` with tone `warning`, icon `clock-alert`, title "This may be out of date"
  (`common.state.stale.title`) and body naming the source and age: "Last update from Airwallex 6 min
  ago. Carnet is retrying." with a "Check now" button.
- Placement: directly under the screen title, above content, in a reserved slot (the slot exists
  empty at 0 height and expands with a `--duration-base` animation that is outside the LCP element so
  CLS stays within budget; under reduced motion it appears instantly).
- Thresholds: transfer and RFI state older than 2 polls failed in a row (6 s) → LiveIndicator turns to
  "Retrying"; older than 60 s → StaleBanner; Airwallex unreachable (circuit open) → banner says
  "Airwallex is not responding. Execution waits; nothing is sent until it recovers." (architecture §9).
- When stale, money actions stay disabled with the reason "Waiting for fresh data from Airwallex".

### LiveIndicator

"Live · checked 3 s ago" with a 8px dot (`--status-progress-fg`; pulsing unless reduced motion) and a
`<time>` element. States: `live`, `retrying` (warning icon + "Retrying, last checked 12 s ago"),
`paused` (tab hidden: polling stops on `visibilitychange` and resumes with an immediate fetch).
The dot is decorative; the text carries the meaning.

### EvidenceStrength

Badge-like indicator for a payment's evidence: `strong` (success, `shield-check`, "Evidence strong"),
`weak` (warning, `shield-alert`, "Evidence weak: 1 check failed"), `missing` (danger, `shield-x`,
"No supporting document"), `needs-confirmation` (warning, `user-check`, "Confirm 2 facts"). Links to the
evidence view.

### ClaimRow (hold screen)

One sentence-level claim in a draft and its citations; see `screens/hold-screen.md` for the layout. A
claim is a span of the answer text the drafter tied to one or more fact citations.

### AppShell

- **Skip link** as the first focusable element: "Skip to main content" (`shell.skipLink`), visible on
  focus, targets `<main id="main" tabindex="-1">`.
- **Header** (56px): product name "Carnet" as a text wordmark linking home (`shell.header.home`; no
  logo image required) and the environment pill "Sandbox · no real money" (`shell.header.sandbox`,
  neutral tone, always visible at every width; `shell.header.sandboxHint` is its screen-reader
  description; Carnet is sandbox-only). The pill describes how Carnet is set up, never a live
  connection state: connectivity is shown only by LiveIndicator and StaleBanner (M1-07 design review). **When data exists**
  (session from M1-04, data from M1-08 onward): the business name ("Northwind Studio Ltd") and the user
  menu. In M1-07 the shell has no session, so the header shows the wordmark and the Sandbox pill only.
- **Nav** (`<nav aria-label="Main">`): Queue (`shell.nav.queue`, icon `list-checks`), Plan
  (`shell.nav.plan`, `calendar-range`), Ops (`shell.nav.ops`, `activity`). Current page uses
  `aria-current="page"` plus `--accent` fill and a 3px left rule (not colour alone). The nav's
  accessible name is `shell.nav.label`. **When data exists** (M1-08 onward), a count pill on Queue
  shows open holds: "1 held" with the held icon (`shell.nav.heldCount`); in M1-07 it is absent.
  - 1440: left sidebar 216px, labels visible.
  - 768: 64px icon rail with visible labels under icons at `--text-xs` (labels are not tooltip-only).
  - 375: bottom tab bar, 3 items, 56px tall plus safe area, each target ≥ 44×44. The current item's
    3px rule sits on the top edge (the bar is horizontal), with `aria-current` and the accent fill.
- **Replay banner** slot above the header when the session is the judge replay (non-dismissible).
- **Kill-switch banner** slot: if `execution_enabled` is false, every screen shows "Execution is paused
  by an operator. Carnet will not send money or answers." (`shell.killSwitch.banner`).
- `error.tsx` and `not-found.tsx` render inside the shell with the error pattern from `states.md`.
- Theme follows the system; no toggle in M1.
