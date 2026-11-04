# State patterns

Every screen designs these states. Each screen spec says which apply and what its copy is; this file
fixes how they look and behave. The rule behind all of them: **never a spinner without context, never
a success the server has not confirmed.**

## Loading

- **First load** of a route renders the shell immediately (server component) and a skeleton of the
  content shaped exactly like the final layout: table rows at their final height, badge-sized blocks
  where badges go, an amount-sized block where MoneyDisplay goes. Next.js `loading.tsx` per route.
- The skeleton has a visually hidden status: "Loading payments" (`common.state.loading` with the
  object name), announced once via `role="status"`.
- Skeleton blocks use `--muted` with no shimmer under reduced motion (a slow 1.2 s opacity pulse
  otherwise).
- After **800 ms** without data, a text line appears inside the reserved slot: "Still loading. Carnet is
  reading from its database." After **8 s**: switch to the error pattern with Retry. Loading never runs
  indefinitely.
- **Refetches** (polling) never show a skeleton again. Existing data stays on screen; the
  LiveIndicator shows freshness.

## Empty

An empty state explains why it is empty and offers the next step. It is not a decorative illustration.

Anatomy: a lucide icon at 24px in `--muted-foreground`, a title (`--text-lg`), one or two sentences,
one action (or none if no action is possible), and, for a first-run judge, a one-line "what this screen
does" sentence.

| Kind | Example |
|---|---|
| First run | Queue: "No payments yet. Add the obligations you need to pay and Carnet checks the evidence for each before anything moves." CTA "Add a payment" |
| Nothing needs you | Queue filter "Held": "Nothing is held. Carnet checks Airwallex every minute and will show a request here." No CTA |
| Filter excluded everything | "No payments match 'EUR, held'." CTA "Clear filters" |
| Not yet available | Plan before obligations exist: "No plan yet. A plan appears when you have at least one obligation with a due date." |

## Error

Three levels, never mixed:

1. **Field / inline** (a draft edit fails validation): text under the field, `--destructive`, icon
   `circle-alert`, `aria-describedby` on the field, `aria-invalid="true"`.
2. **Section** (one panel's fetch fails, others are fine): the panel keeps its frame and shows an
   `Alert` (destructive tone) in place of its content: what failed, that nothing was changed, and a
   Retry button. Other panels keep working.
3. **Page** (`error.tsx`): inside the shell, title "Carnet could not load this page", body naming what
   is safe ("No money or answers were sent from this page."), Retry and "Go to the queue". A
   correlation id in mono with Copy so the finance lead can report it; no stack trace.

Error copy formula: **what happened · what is safe · what happens next / what to do**. Example:
"Airwallex did not respond within 10 s. No answer was sent. Carnet will look up the request before
retrying; you do not need to approve again."

Money and approval errors are always **page-anchored** (they stay until resolved). They are never a
toast.

`not-found.tsx`: "This page does not exist, or it belongs to another business." (Deliberately does not
distinguish the two: tenancy, ADR 0012.)

## Stale data

Data is stale when it is older than its freshness budget or the last fetch failed.

| Data | Freshness budget | Indicator |
|---|---|---|
| Transfer status, RFI state on a screen that waits for an event | 3 s poll; stale after 2 consecutive failures | LiveIndicator "Retrying"; after 60 s, StaleBanner |
| Queue and plan (server-rendered) | reconcile runs every 60 s | "Updated 〈time〉" under the title; StaleBanner if the reconciler's last successful run is older than 3 min |
| Balances used by the plan | read at plan time | "Balances as of 〈time〉"; StaleBanner when older than 5 min, and plan actions that move money are disabled until refreshed |
| Ops metrics | 15 s poll | "Updated 〈time〉" only |

While stale: data stays visible (never blanked), money actions are disabled with the visible reason
"Waiting for fresh data from Airwallex", and "Check now" triggers an immediate fetch.

## Waiting for Airwallex

The distinctive Carnet state. It covers: an execution attempt in `INTENT` or `SENT_TO_AIRWALLEX`, an
attempt in `UNKNOWN` (timed out; the reconciler is looking it up), an RFI in `ANSWER_SUBMITTING`, a
submitted RFI waiting for `ANSWERED`, and a transfer whose outcome Airwallex is still deciding.

Pattern:
- Progress tone, LiveIndicator, and a **step list** that names where the request is, each step with
  its own icon and text, filled only from server state:

  ```
  ✓ Approved by you · 14:02:11
  ✓ Sent to Airwallex · 14:02:12 · request req_7c1e…
  ◌ Waiting for Airwallex to confirm · checked 3 s ago
  ```
  (Glyphs above are illustrative; the build uses lucide `circle-check` and `loader-circle`, with text.)
- `UNKNOWN` has its own honest copy: "Airwallex did not confirm in time. Carnet is looking the request
  up before doing anything else; it will not send it twice." No retry button for the owner (ADR 0007:
  lookup, never a new request id).
- After 2 minutes in one step: add "This is taking longer than usual. You can leave this page; Carnet
  keeps checking and the queue will show the result."
- The user can navigate away. Nothing is lost; the queue row shows the same waiting badge.

## Pending action (no optimistic updates)

For any action that moves money or changes an approval (ADR 0017):
- On click, the button enters `pending`: disabled, static spinner icon, label changes to the
  in-progress verb ("Submitting to Airwallex…"), `aria-busy="true"`. The rest of the page stays
  interactive except controls that would change the same content (draft editors lock).
- The UI renders the new state **only when the server response or the next poll confirms it**. No
  ticks, "Done" toasts or status changes before that.
- Double submits are impossible: the button is disabled and the request carries an idempotency key; a
  repeated click while pending does nothing.
- If the request fails, the button returns to its prior state with the error pattern next to it.

## Partial

When some data loaded and some did not (for example the RFI loaded but one cited document's preview
failed): show what loaded, mark the missing part in place with a section error, and keep actions that
do not depend on it. Approval stays disabled if it depends on the missing part ("A cited document did
not load. Reload before approving.").

## Offline

Detected via `navigator.onLine` plus failed polls. A top `Alert` (warning): "You are offline. What you
see may be out of date; actions are paused until you reconnect." Money actions are disabled; draft
edits are kept in the textarea (not saved to the server until online, and labelled "Not saved").

## Strings keys (shared)

`common.state.loading`, `common.state.loadingSlow`, `common.state.retry`, `common.state.error.title`,
`common.state.error.body`, `common.state.error.correlationId`, `common.notFound.title`,
`common.notFound.body`, `common.action.home`, `common.state.stale.title`, `common.state.stale.body`,
`common.state.stale.checkNow`, `common.state.stale.actionsDisabled`, `common.state.waitingAirwallex`,
`common.state.waiting.approved`, `common.state.waiting.sent`, `common.state.waiting.confirming`,
`common.state.waiting.unknown`, `common.state.waiting.slow`, `common.state.offline`,
`common.state.partial.approvalBlocked`, `common.state.unsaved`, `common.time.checkedAgo`,
`common.time.updatedAt`.
