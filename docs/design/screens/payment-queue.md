# Payment queue

Built by M2-03 (server component). Route: `/queue` (the default page after login; the shell home links
to it).

## Purpose

The first screen an owner and a judge see. It states the goal ("Pay payroll and two suppliers by Fri
7 Nov"), lists every payment that serves it with its evidence strength and its Airwallex transfer
status, and puts the one thing that needs attention (a held payment) at the top with its next step.
It answers: *Is everything going to be paid on time, and if not, what do I do now?*

## Data shown

| Data | Source | Notes |
|---|---|---|
| Goal: text, deadline | business goal / obligations | "Pay payroll and two suppliers by Fri 7 Nov" |
| Summary counts | projection over payments | "5 payments · 3 sent · 1 held for information · 1 not sent", and "Payroll funded in plan revision 4" (link) |
| Held callout | payments with `held = true` | Counterparty, amount, RFI deadline, Carnet state ("Drafts ready", "Needs you"), CTA "Review and answer" |
| Per payment row | `payments`, `obligations`, `counterparties`, evidence rules | Counterparty name and country, purpose/reference, amount (MoneyDisplay), due date, criticality (payroll / supplier / other), EvidenceStrength, StatusBadge pair, next action |
| Freshness | reconciler last run | "Updated 14:03 · Live" |

Sort: held first, then failures and `OVERDUE`, then by due date. Filters (chips, multi-select): All,
Held, Needs evidence, Not sent, In flight, Paid; currency.

## Layout (375 / 768 / 1440)

- **1440:** shell sidebar; content: title row (h1 "Payments" + LiveIndicator right), goal card (goal
  sentence at `--text-lg`, summary counts, plan link), held callout (an `Alert` in `held` tone: icon,
  "Rheinblick Druck GmbH · EUR 7,200.00 is held for information. Carnet drafted 2 of 3 answers.
  Answer by Thu 6 Nov 18:00." and primary button "Review and answer"), filter chips, then a Table:
  Counterparty | Purpose | Due | Amount (right) | Evidence | Status | Next step. Max content width
  1312px; table rows 48px.
- **768:** nav rail; same order; the table drops the Purpose column (shown as a second line under
  counterparty) and the Next step column becomes a link in the row's last cell.
- **375:** bottom tab bar; title, goal card, held callout (button full width), filter chips in a
  horizontally scrollable row with visible overflow fade and scroll buttons, then **stacked rows**
  (not a table): line 1 counterparty + amount right; line 2 due date + criticality; line 3 badges
  (wrap); the whole row is a 44px+ link to the payment.

## Components

AppShell, LiveIndicator, Card (goal), Alert (`held` tone callout), Button, filter chips (`ToggleGroup`
styled as chips with a check icon when selected), Table, MoneyDisplay, EvidenceStrength, StatusBadge,
Skeleton, StaleBanner, Tooltip.

## States

### Loading

Title and goal card skeleton, one callout-sized block, 5 table-row skeletons at 48px (stacked-row
skeletons on mobile). Status text "Loading payments".

### Empty

No payments and no goal: `queue.empty.title` "No payments yet" / `queue.empty.body` "Add what you need
to pay and by when. Carnet checks the evidence for each payment before anything moves." In M1 (shell
only) the CTA is absent; from M2-03, CTA "Add a payment". Filtered empty: "No payments match these
filters." + "Clear filters". No held payments: the callout slot is not rendered (no "all good" banner).

### Error

Section error replacing the table: "Carnet could not load your payments. Nothing was sent or changed.
Retry." Goal card still shows if it loaded. Page error falls back to `error.tsx`.

### Stale

Reconciler's last successful run older than 3 min: StaleBanner "Transfer statuses were last checked
with Airwallex 4 min ago. Carnet is retrying." Statuses remain visible; "Approve and send" actions
disabled with the reason.

### Waiting for Airwallex

Rows whose execution attempt is in progress or `UNKNOWN` show a progress badge "Waiting for
Airwallex" (or "Confirming with Airwallex" for `UNKNOWN`) in the Next step column, linking to the
payment detail; the row does not show a transfer status that Airwallex has not reported yet.

## Interactions

- Polls every 3 s while a row is waiting or held; otherwise server render plus 60 s soft refresh.
- Row link → evidence view (or hold screen if held). The badge link goes to its reason.
- "Review and answer" → hold screen.
- Filter chips update the URL query (`?status=held`) so views are shareable and the back button works.
- "Approve and send" (for payments with strong evidence, not yet sent) opens the payout approval
  dialog (bound approval, same pattern as hold) from the evidence view, not inline in the table.

## Keyboard and accessibility

- `h1` "Payments"; goal card is a `section` with `aria-labelledby`; table has a `<caption>` (visually
  hidden) "Payments for the goal: pay payroll and two suppliers by Friday 7 November".
- First cell of each row is the link; whole-row click is an enhancement only.
- Filter chips are toggle buttons with `aria-pressed`; result count announced politely ("2 payments
  shown").
- Status changes from polling announce per `accessibility.md` ("Harbor Print Co., USD 4,800.00:
  Airwallex reports Paid").
- At 375 each stacked row is a single link with an accessible name that includes counterparty,
  amount, due date and status.

## Strings keys used

- `queue.title`, `queue.goal.label`, `queue.goal.deadline`, `queue.summary.counts`,
  `queue.summary.planFunded`, `queue.summary.planLink`
- `queue.held.body`, `queue.held.draftProgress`, `queue.held.deadline`, `queue.held.cta`
- `queue.filter.label`, `queue.filter.all`, `queue.filter.held`, `queue.filter.needsEvidence`,
  `queue.filter.notSent`, `queue.filter.inFlight`, `queue.filter.paid`, `queue.filter.currency`,
  `queue.filter.clear`, `queue.filter.resultCount`
- `queue.table.caption`, `queue.table.counterparty`, `queue.table.purpose`, `queue.table.due`,
  `queue.table.amount`, `queue.table.evidence`, `queue.table.status`, `queue.table.nextStep`
- `queue.criticality.payroll`, `queue.criticality.supplier`, `queue.criticality.other`
- `queue.next.review`, `queue.next.answer`, `queue.next.approveSend`, `queue.next.waiting`,
  `queue.next.confirming`, `queue.next.none`
- `queue.empty.title`, `queue.empty.body`, `queue.empty.cta`, `queue.emptyFiltered.title`
- `queue.error.load`, `queue.loading.status`
- `evidence.strength.strong`, `evidence.strength.weak`, `evidence.strength.missing`,
  `evidence.strength.needsConfirmation`
- `status.held.label`, `status.transfer.none.label`, `status.transfer.scheduled.label`,
  `status.transfer.processing.label`, `status.transfer.sent.label`, `status.transfer.paid.label`,
  `status.transfer.failed.label`, `status.transfer.cancelled.label`, `status.transfer.overdue.label`
- `common.state.stale.title`, `common.state.stale.body`, `common.state.retry`,
  `common.state.waitingAirwallex`, `common.time.updatedAt`, `common.time.checkedAgo`

## Built by M2-03: differences from this spec (owner informed, 2026-11-11)

- Goal, due date and criticality come from obligations (M3). Until they exist the goal card shows its
  empty wording, the Due column shows a muted dash, and criticality is not shown. Nothing is invented.
- Below 1280px the list is stacked cards (not a table at 768) because the 768px rail leaves too little
  width for the columns; Next step is a link on each card.
- Filters are three labelled chip groups (Show, Evidence strength, Currency) in the URL, not one scrolling row.
- The held callout shows the payee, amount and the RFI deadline from the open RFI; draft progress is on the hold screen.
- Counts: reported by Airwallex, waiting for Airwallex, not sent, and how many are held.
