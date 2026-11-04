# Plan screen

Built by M3-04 (server component; client island for the approval dialog). Route: `/plan`.

## Purpose

Show the hold-aware plan: how the goal's obligations (payroll, suppliers) get funded by their due
dates given what is available, treating held funds as unavailable. When a payment is held, the planner
re-runs and this screen shows **what changed and why**, which actions Carnet executed on its own under
the policy limits (FX conversions under the daily cap), and which actions need the owner's bound
approval (alternate payout, defer). Pillar 3, and storyboard 2:05.

## Data shown

| Data | Source | Notes |
|---|---|---|
| Plan headline | `plans` (latest revision) | "Revision 4 · payroll funded · 1 supplier deferred to Mon 10 Nov" with the trigger: "Re-planned at 14:01 because Rheinblick Druck's payment is held for information" |
| Balances used | balances read at plan time | Per currency (MoneyDisplay), "as of 14:01"; held transfers already debited (observed in M0-04) and listed as "held, unavailable" |
| Obligations | `obligations` | Counterparty, criticality (owner-confirmed or "proposed by Carnet, confirm"), amount, due date, funded yes/no in this revision |
| Actions needing approval | `plan_actions` status `PROPOSED` | Kind (alternate payout, defer, convert above limit), exact parameters, why, ApprovalBar per action |
| Auto-executed actions | `plan_actions` `AUTO_APPROVED` → `EXECUTING` → `DONE`/`FAILED` | "Converted USD 7,890.12 → EUR 7,200.00 at 0.91253 under your daily auto-convert limit (USD 10,000.00; USD 2,109.88 left today) · policy v3" |
| Revision diff | `plans` previous revision | Added / removed / changed actions vs revision 3 |
| Explanation | `plans.explanation` | Plain-language, generated from the planner's structured output (code, not the model) |

## Layout (375 / 768 / 1440)

- **1440:** h1 "Plan" + LiveIndicator; headline Card (funded state with icon + text, trigger sentence,
  "Balances as of"); two-column below: left (7fr) "Needs your approval" list of action Cards, then
  "Done automatically" list, then "What changed since revision 3" (Collapsible); right (5fr) balances
  card and obligations Table (Counterparty | Due | Amount | Funded). Each approval Card ends with its own
  inline ApprovalBar (one bound approval per action).
- **768:** single column in the same order; obligations table keeps 4 columns.
- **375:** single column; obligations as stacked rows; each action Card has a full-width 48px approve
  button; balances as a compact list.

## Components

AppShell, LiveIndicator, Card, StatusBadge (action statuses mapped to tones: proposed neutral,
executing progress, done success, failed danger), MoneyDisplay (`converted`, `delta`), ApprovalBar
(per action), Dialog (bound payout approval showing source account, beneficiary fingerprint, amount,
currency, fee option, value date, reference), Table, Collapsible, Alert, Skeleton, StaleBanner, Tooltip
(policy hash, rate bounds).

## States

### Loading

Headline skeleton, two action-card skeletons, balances and obligations skeleton. Status "Loading the
plan".

### Empty

`plan.empty.title` "No plan yet" / `plan.empty.body` "A plan appears when you have at least one
obligation with a due date. Carnet re-plans whenever a payment is held or a balance changes." No
actions needing approval: the section shows "Nothing needs your approval in this revision."

### Error

Planner failed: destructive Alert "Carnet could not compute a new plan. The last plan (revision 3,
14:00) is shown and nothing new will execute until a plan is computed. Retry." Auto-executed action
failed: the action card shows Failed with Airwallex's `failure_reason` and "No further automatic
conversions will run today without your approval" if the circuit breaker opened.

### Stale

Balances older than 5 min: StaleBanner "Balances were read from Airwallex 7 min ago." Actions that
move money are disabled until "Check now" refreshes and the plan re-runs. A newer revision exists than
the one on screen (another event re-planned): banner "A newer plan (revision 5) is available. Your
approval applies only to the revision shown." with "Show revision 5"; approvals on the old revision
are refused server-side (hash).

### Waiting for Airwallex

Per action: the waiting step list for executing actions, including FX conversions that auto-execute
("Converting with Airwallex… quote valid 30 s"); `UNKNOWN` copy as in `states.md`.

## Interactions

- Approve an action → Dialog with exact parameters → pending → waiting → done (server-confirmed only).
- Reject an action → AlertDialog "Reject this plan action" → planner re-runs; the next revision appears.
- Confirm a proposed criticality ("Carnet proposes: payroll, critical. Confirm") → server-confirmed.
- Revision diff expands; each changed action links to its card.
- Polls every 3 s while any action is executing or an RFI is open; otherwise 60 s.

## Keyboard and accessibility

- `h1` "Plan"; sections `h2` "Needs your approval", "Done automatically", "What changed", "Balances",
  "Obligations".
- Funded / not funded uses icon + text ("Payroll funded", "Not funded by due date"), never colour only.
- Each action Card's approve button names the action and amount ("Approve alternate payout of EUR
  7,200.00 to Rheinblick Druck GmbH").
- New revision arriving is announced politely ("Plan revised: revision 5, payroll still funded"); it
  does not replace the view under the user's focus without the explicit "Show revision 5".
- Deltas use signed amounts with words in the accessible name ("EUR 7,200.00 less available").

## Strings keys used

- `plan.title`, `plan.headline.revision`, `plan.headline.funded`, `plan.headline.notFunded`,
  `plan.headline.trigger`, `plan.balances.title`, `plan.balances.asOf`, `plan.balances.heldUnavailable`
- `plan.section.needsApproval`, `plan.section.auto`, `plan.section.changed`, `plan.section.obligations`
- `plan.action.alternatePayout`, `plan.action.defer`, `plan.action.convert`, `plan.action.why`,
  `plan.action.autoUnderLimit`, `plan.action.limitRemaining`, `plan.action.policyVersion`
- `plan.action.approveCta`, `plan.action.approveCtaPending`, `plan.action.rejectCta`,
  `plan.action.rejectConfirm`, `plan.action.statusProposed`, `plan.action.statusExecuting`,
  `plan.action.statusDone`, `plan.action.statusFailed`
- `plan.dialog.title`, `plan.dialog.body`, `plan.dialog.boundNotice`, `plan.dialog.confirm`
- `plan.criticality.proposed`, `plan.criticality.confirmCta`
- `plan.obligations.counterparty`, `plan.obligations.due`, `plan.obligations.amount`,
  `plan.obligations.funded`
- `plan.newRevision.body`, `plan.newRevision.cta`, `plan.noneNeedsApproval`
- `plan.empty.title`, `plan.empty.body`
- `plan.error.planner`, `plan.error.autoFailed`, `plan.error.breakerOpen`, `plan.loading.status`
- `common.state.stale.title`, `common.state.stale.body`, `common.state.stale.checkNow`,
  `common.state.waiting.approved`, `common.state.waiting.sent`, `common.state.waiting.confirming`,
  `common.state.waiting.unknown`
