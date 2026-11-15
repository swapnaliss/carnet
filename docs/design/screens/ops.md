# Ops

Data from M1-09 (observability baseline); kill switch and caps from M4-02; audit chain from M4-01.
Route: `/ops` (owner and approver roles; a viewer reads it read-only in replay mode, under the recording banner, M4-05; no session redirects to `/login`).

## Purpose

Prove the system is governed and healthy, for the operator and for a judge checking claims: are
webhooks arriving and being processed, are jobs flowing, are any money calls in an unknown state, are
the SLOs met, how much model spend is used against the caps, is the audit chain intact, and are agents
and execution switched on. Pillar 4, governed execution and audit.

## Data shown

| Data | Source | Notes |
|---|---|---|
| Switches | `system_flags` | `agents_enabled`, `execution_enabled`, each with state, changed by, changed at |
| SLO tiles | DB timestamps (ADR 0015) | Webhook ack p95 (target < 300 ms), RFI event to draft ready p95 (< 60 s), approval to RFI answered p95 (< 30 s), payments marked sent/paid by an RFI event alone (target 0) with window and sample size |
| Spend | `agent_runs`, `system_flags` | Today and total vs `daily_spend_cap` and grant cap (MoneyDisplay USD) |
| Jobs | `outbox_jobs` | Counts by status (`PENDING`, `RUNNING`, `RETRY`, `DEAD`), oldest pending age, last 50 with kind, attempts, last error (truncated) |
| Webhooks | `webhook_events` | Last 50: provider event id (mono), name, received, signature ok, processed, duplicate |
| Execution attempts | `execution_attempts` | Any `UNKNOWN` first; kind, request id, age, resolution |
| Reconciler | job timestamps | Last run, last success, next run |
| Audit chain | `audit_log` verification | "Verified 1,284 entries, chain intact, 14:00" or the first broken link |
| Agent runs | `agent_runs` | Last 20: kind, ref, status, tokens, cost, latency |

## Layout (375 / 768 / 1440)

- **1440:** h1 "Ops" + LiveIndicator; switches row (two Cards with state + "Pause" / "Resume"); SLO
  tiles row (4 Cards: value, target, pass/fail icon + label, sample size); spend Card and audit Card
  side by side; Tabs: Jobs | Webhooks | Attempts | Agent runs, each a dense Table (40px rows,
  `--text-sm`, mono ids).
- **768:** tiles 2×2; tables keep columns, horizontal scroll inside the table region only (with a
  visible scroll hint and keyboard-focusable region).
- **375:** single column; tiles stacked; tables become stacked rows with the 3 most useful fields;
  switches have 48px buttons.

## Components

AppShell, LiveIndicator, Card, StatusBadge (job and attempt statuses: pending neutral, running
progress, done success, retry warning, dead danger, unknown warning "Confirming"), MoneyDisplay, Tabs,
Table, AlertDialog (pause / resume execution or agents), Alert, Skeleton, StaleBanner, Tooltip, copy
buttons.

## States

### Loading

Switch, tile and table skeletons at final size. Status "Loading system health".

### Empty

`ops.empty.title` "No activity yet" / `ops.empty.body` "Webhooks, jobs and model runs appear here as
they happen. Carnet checks Airwallex every 60 seconds even without webhooks." Per tab: "No webhooks
received yet" etc. SLO tiles with no samples show "No data yet (0 samples)", never a green pass.

### Error

Section errors per panel; a failed audit verification is a danger Alert with the first broken entry id
and "This is a tamper signal. Carnet keeps running; investigate before trusting history after entry
〈id〉." (not dismissible).

### Stale

Metrics poll every 15 s; after 2 failures the LiveIndicator shows "Retrying"; reconciler last success
older than 3 min: StaleBanner "The reconciler has not completed since 14:00. Missed webhooks will not be
recovered until it runs."

### Waiting for Airwallex

Attempts tab: `UNKNOWN` attempts show "Confirming with Airwallex (lookup)" with age; no manual resend
control exists (ADR 0007).

## Interactions

- Pause / resume execution and agents: AlertDialog explaining the effect ("Pausing execution stops new
  payouts, conversions and RFI answers and invalidates pending approvals. Requests already sent to
  Airwallex finish."), then pending, then server-confirmed state.
- Tabs keep state in the URL hash.
- Copy ids; expand a job's last error.
- "Verify audit chain now" button (pending until the server returns).

## Keyboard and accessibility

- `h1` "Ops"; switches are buttons, not toggle switches, so the action is explicit ("Pause
  execution"); state as text ("Execution is on").
- SLO pass/fail: icon + "Meets target" / "Misses target" + value; never colour alone.
- Tables have captions; scrollable regions are focusable with `tabindex="0"` and a label.
- Kill switch state change is announced assertively on every screen (see `accessibility.md`).

## Strings keys used

- `ops.title`, `ops.switch.agents`, `ops.switch.execution`, `ops.switch.stateOn`,
  `ops.switch.stateOff`, `ops.switch.pauseCta`, `ops.switch.resumeCta`, `ops.switch.ctaPending`,
  `ops.switch.confirmTitle`, `ops.switch.confirmBody`, `ops.switch.changedBy`
- `ops.slo.webhookAck`, `ops.slo.eventToDraft`, `ops.slo.approvalToAnswered`, `ops.slo.rfiOnlyStatus`,
  `ops.slo.meets`, `ops.slo.misses`, `ops.slo.noData`, `ops.slo.samples`
- `ops.spend.title`, `ops.spend.today`, `ops.spend.cap`
- `ops.audit.title`, `ops.audit.intact`, `ops.audit.broken`, `ops.audit.verifyCta`,
  `ops.audit.verifyCtaPending`
- `ops.tabs.jobs`, `ops.tabs.webhooks`, `ops.tabs.attempts`, `ops.tabs.agentRuns`
- `ops.jobs.caption`, `ops.webhooks.caption`, `ops.attempts.caption`, `ops.attempts.confirming`,
  `ops.runs.caption`, `ops.reconciler.lastRun`, `ops.reconciler.stale`
- `ops.empty.title`, `ops.empty.body`, `ops.emptyTab.webhooks`, `ops.emptyTab.jobs`,
  `ops.emptyTab.attempts`, `ops.emptyTab.runs`
- `ops.error.panel`, `ops.loading.status`
- `shell.killSwitch.banner`, `common.state.stale.title`, `common.state.retry`, `common.action.copy`,
  `common.action.details`
