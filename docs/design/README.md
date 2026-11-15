# Carnet design

The design system and screen specs for Carnet's web app. Every `frontend` ticket builds to these files
and is reviewed against them by the independent `ui-reviewer`. Produced by the `ux-designer` agent for
ticket M1-07 on 4 Nov 2026.

**Tooling note.** The `frontend-design` skill was **not installed** in this environment when M1-07 ran, so
these decisions apply the `ux-designer` rules on their own: evidence
over decoration, status never by colour alone, calm density, honest copy, live not refresh, every state
designed, every script rendered, WCAG 2.2 AA, no template look.

## File index

| File | What it fixes |
|---|---|
| [`tokens.md`](tokens.md), [`tokens.css`](tokens.css) | Colour (light, dark, status tones), contrast ratios, type, spacing, radius, elevation, motion |
| [`components.md`](components.md) | shadcn components and variants; Carnet components (StatusBadge, MoneyDisplay, CitationChip, SourceSnippet, ApprovalBar, StaleBanner, LiveIndicator, AppShell) |
| [`states.md`](states.md) | Loading, empty, error, stale-data, waiting-for-Airwallex and pending-action patterns |
| [`accessibility.md`](accessibility.md) | WCAG 2.2 AA rules, focus order, keyboard map, live regions for polling, target sizes |
| [`performance.md`](performance.md) | Core Web Vitals budgets per screen and how they are measured |
| [`screens/payment-queue.md`](screens/payment-queue.md) | The goal and its payments, evidence strength, transfer status (M2-03) |
| [`screens/evidence-view.md`](screens/evidence-view.md) | One payment's documents, extracted facts with quotes, evidence checks (M2-03) |
| [`screens/hold-screen.md`](screens/hold-screen.md) | **Hero.** A held payment's RFI, cited drafts, one bound approval (M2-08) |
| [`screens/plan-screen.md`](screens/plan-screen.md) | Hold-aware plan: obligations, revised actions, auto-FX vs approval (M3-04) |
| [`screens/ops.md`](screens/ops.md) | SLOs, jobs, webhooks, attempts, kill switch, audit chain (M1-09 data, M4) |

## Who it is for

| User | Device and context | Language and skill | The one job they came to do |
|---|---|---|---|
| **Founder-operator** of a 5–30 person cross-border agency (Northwind Studio in the demo) | Laptop at a desk most of the time; phone when a hold notification arrives late in the day | English as a working language, often not first; knows their clients and suppliers, not compliance vocabulary | Get payroll and the suppliers paid by Friday even though one payment is held |
| **Part-time finance lead** at an importer | Desktop, two monitors, a spreadsheet open next to Carnet; a few hours a week | Fluent with invoices, POs, IBANs and FX; impatient with vague status | Answer the RFI once, correctly, with the right documents, and tell suppliers something true |
| **Solo exporter** | Phone first (375px), between other work; patchy connection | Plain-language reader; may read German or Chinese counterparty names | See whether a payment is stuck, why, and the single thing to approve |
| **Hackathon judge** | Laptop, a browser tab among many, about three minutes, may open the judge replay login | Expert reader of fintech demos, zero context on this business | Understand on the first screen what Carnet does and see a held payment answered with cited evidence and a bound approval |

Design consequences:
- **The first screen explains itself.** The queue opens with the business goal in plain words ("Pay
  payroll and two suppliers by Friday 7 Nov"), a one-line summary ("3 of 5 payments sent · 1 held for
  information · payroll funded"), and the held payment pinned at the top with its next step. A judge
  can follow the storyboard without narration.
- **The judge replay is labelled.** When the session is the recorded replay, a persistent banner says
  so (`shell.replay.banner`): "You are viewing a recording of a real sandbox run on 〈date〉. Actions are
  disabled." It is not dismissible and it is not styled as an error.
- **Phone is a first-class path for one job only:** see the hold, read drafts with their sources,
  approve. Ops and plan editing are usable on a phone but tuned for desktop.

## Principles (applied)

1. **Evidence over decoration.** Every status links to its reason: a transfer badge opens the
   Airwallex status and `failure_reason`; an evidence flag opens the failing check; a claim opens its
   source snippet. No hero illustrations, no gradient banners, no stock icons standing in for data.
2. **Status is never colour alone.** Every status is icon + label + tone (see StatusBadge). The held
   flag is a separate badge beside the transfer status, never a replacement for it.
3. **Calm density.** Tables over cards when comparing many rows; one primary action per view; muted
   meta text; dividers instead of boxes; numbers aligned on tabular figures.
4. **Honest copy.** Say what Airwallex reported and what Carnet inferred, separately. Never "approved
   by Airwallex", "cleared", "guaranteed" or "compliant". `SENT` is "Sent, not yet paid"; `PAID` is "Paid
   (Airwallex reports)". `CANCELLED` never implies a person cancelled.
5. **Live, not refresh.** Screens that wait for an event poll every 3 s and show "Checked 4 s ago";
   nothing says "Loading…" without saying what it is waiting for.
6. **Every state designed.** Each screen spec lists loading, empty, error, stale and, where relevant,
   waiting for Airwallex. See `states.md`.
7. **Every script renders.** Latin-ext in the brand face; CJK fallback in the stack; long German
   compound names wrap, never clip.
8. **WCAG 2.2 AA** is the floor: contrast verified by script, visible focus, full keyboard paths, 24px
   targets everywhere and 44px below 768px or on coarse pointers.
9. **No template look.** No gradient hero, no emoji, no lorem ipsum, no "Welcome back!" card grid.
   Copy and examples use the synthetic dataset (Northwind Studio, Rheinblick Druck, Harbor Print).

## Copy rules

- **Voice:** plain, specific, calm. Short sentences. Second person for the owner ("You approved …"),
  third person for systems ("Airwallex reports …", "Carnet drafted …").
- **Attribute every fact to its source.** "Airwallex reports: Processing" · "From invoice RD-2026-1180,
  page 1" · "Carnet's check: amount matches the invoice". Inference is labelled: "Carnet infers …".
- **Never overclaim.** Forbidden in UI copy: "approved by Airwallex", "cleared", "compliant",
  "guaranteed", "will be released", "AI verified", "100% accurate", "instant". Carnet "drafts", "checks",
  "submits"; Airwallex "reviews" and "decides".
- **An RFI never changes the money status in copy either.** After submitting: "Answer submitted to
  Airwallex. The transfer is still Processing; Airwallex decides the outcome." Never "Payment released".
- **Numbers:** always with currency code (`EUR 7,200.00`, not `€7.2k`); dates with weekday for
  deadlines ("Fri 7 Nov"); relative time only for freshness ("checked 4 s ago") with the absolute time in
  a tooltip and `<time datetime>`.
- **Buttons say what happens:** "Approve and submit 3 answers", not "Confirm". Destructive or
  irreversible actions name the object ("Reject this plan action").
- **Errors say what happened, what is safe, and what to do:** "Airwallex did not respond in 10 s. No
  answer was sent. Carnet will check again in 30 s." Never a raw stack trace or HTTP code alone (codes
  go in a details disclosure for the finance lead).
- **Sentence case** everywhere, including statuses and buttons. No exclamation marks.
- **Identifiers** (RFI id, request id, hash) in mono, shortened with a copy button: `rfi_8f3a…c21d`.

## Strings-key naming convention

All user-facing text lives in `apps/web/src/strings.ts` (ADR 0017). Keys are **dotted camelCase paths**:

```
<area>.<screen-or-component>.<element>
```

- `area` is one of `common`, `shell`, `home`, `status`, `money`, `queue`, `evidence`, `hold`, `plan`,
  `ops`, `payee`, `auth`.
- `screen-or-component` is the region within it (`nav`, `empty`, `approval`, `claim`, `stale`); it may
  nest one more level when a region has named parts (`home.sections.queue.title`).
- `element` is the role of the text (`title`, `body`, `cta`, `label`, `hint`, `error`).
- **Variants are a camelCase suffix on the element, never a further dot** (`hold.approval.ctaPending`,
  never a further `.pending` segment under `hold.approval.cta`). `strings.ts` is a nested `as const` object, so a key cannot be both
  a leaf and a branch: **no key may be a dotted prefix of another key.** Plural or count forms follow
  the same rule (`hold.approval.ctaCount`).
- Examples: `shell.nav.queue`, `queue.empty.title`, `hold.approval.cta`, `hold.approval.ctaPending`,
  `common.state.loading`, `status.transfer.processing.label`.
- Shell keys already in `strings.ts` (M1-07 build): `shell.skipLink`, `shell.nav.label`,
  `shell.nav.queue`, `shell.nav.plan`, `shell.nav.ops`, `shell.header.home`, `shell.header.sandbox`,
  `shell.header.sandboxHint`; `home.title`, `home.body`, `home.sections.{queue,plan,ops}.{title,body}`;
  `queue.empty.{title,body}`, `plan.empty.{title,body}`, `ops.empty.{title,body}`;
  `auth.login.{title,body,back}`; `common.state.error.{title,body}`, `common.state.retry`,
  `common.action.home`, `common.notFound.{title,body}`.
- Interpolated values use named ICU-style placeholders in the string and typed parameters in the
  function: `hold.approval.ctaCount` → "Approve and submit {count} answers". Plurals use
  `Intl.PluralRules`, never string concatenation.
- **Keys are added, never reordered or renamed** (`strings.ts` is a hot file). A removed string is
  deleted in its own change.
- Each screen spec ends with the list of keys it uses; a builder adds exactly those keys (wording may be
  refined in review; key names may not).

Shared keys every screen may use: `common.state.loading`, `common.state.retry`, `common.state.error.title`,
`common.state.error.body`, `common.state.stale.title`, `common.state.waitingAirwallex`,
`common.time.checkedAgo`, `common.action.copy`, `common.action.copied`, `common.action.cancel`,
`common.action.close`, `common.action.details`, `common.action.home`.
