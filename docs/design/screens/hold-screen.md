# Hold screen (hero)

Built by M2-08 (client component, ADR 0017). Route (proposed): `/payments/[paymentId]/hold`, reached from
the queue's held callout, the held badge on any row, and the Queue nav count.

## Purpose

One held payment, one open Airwallex Transaction RFI, and everything needed to answer it once,
correctly: each question with a drafted answer whose every claim sits beside the verbatim source it
came from, the questions Carnet could not ground marked for the owner, and **one bound approval** over
the exact content that will be sent. It also tells the owner, truthfully, what answering does and does
not do: the transfer keeps its own Airwallex status; Airwallex decides the outcome.

This is the storyboard's 1:10–2:05 segment. A judge should understand it in five seconds: "This
payment is held. Airwallex asked three questions. Carnet drafted answers from these documents. I
approve once, and it is sent."

## Data shown

| Data | Source | Notes |
|---|---|---|
| Payment: counterparty, amount, currency, reference, due date, obligation (for example "Supplier: catalogue printing") | `payments`, `obligations` | MoneyDisplay `hero` |
| Transfer status + held flag | `project(transferStatus, openRfi)` from the server | StatusBadge pair `[Held for information] [Processing]`, links to the transfer detail |
| RFI: Airwallex RFI id (mono, shortened), type `TRANSACTION`, Airwallex status (`ACTION_REQUIRED` …), Carnet state (`DRAFTING`, `DRAFT_READY`, `NEEDS_OWNER`, `APPROVED`, `ANSWER_SUBMITTING`, `ANSWERED`, `CLOSED`, `REOPENED`, `EXPIRED`), round number, `expires_at` | `rfis` | Deadline as "Answer by Thu 6 Nov, 18:00 (in 26 h)" |
| Questions: title, description, answer type (`TEXT` / `ATTACHMENT`), round, reopened flag | `rfi_questions` | In Airwallex's order |
| Per question: draft answer text, status (`ready`, `needs owner`, `edited by you`, `reused from round 1`), verifier result | `draft_answers` | Draft id and prompt version in details |
| Per claim: the claim span, its citations (document id, page, fact field, fact version), verification state | `draft_answers.citations`, `document_facts` | |
| Per citation: verbatim quote, document title, filename, page, SHA-256 short | `document_facts.quotes`, `documents` | SourceSnippet |
| Attachments for `ATTACHMENT` questions: document, kind, size, hash | `documents` | Shown as files that will be uploaded |
| Injection flag | extraction pre-scan | If any cited document was flagged, a warning Alert names it |
| Approval: id, status, content hash (short), approver, approved at, expires at | `approvals` | ApprovalBar |
| Execution: attempt status, request id | `execution_attempts` | Waiting-for-Airwallex step list |
| Plan impact: "Plan revision 4: payroll still funded; Rheinblick payment treated as unavailable" | `plans` | One line + link to Plan |
| Earlier rounds (follow-up) | `rfis` answered requests | Collapsed, read-only |

## Layout (375 / 768 / 1440)

### Desktop wireframe (1440)

```
┌──────────┬──────────────────────────────────────────────────────────────────────────────────────────┐
│ Carnet   │ ← Queue                                                         Live · checked 2 s ago ● │
│ Sandbox  │                                                                                          │
│──────────│  Rheinblick Druck GmbH · catalogue printing · ref RD-2026-1180                            │
│▌Queue 1h │  EUR 7,200.00                       [⏸ Held for information] [◌ Processing]              │
│ Plan     │  Airwallex asked for information about this transfer. Its status stays Processing until  │
│ Ops      │  Airwallex decides.     RFI rfi_8f3a…c21d · round 1 · Answer by Thu 6 Nov 18:00 (in 26 h) │
│          │  ┌───────────────────────────────────────────────────────────────────────────────────┐   │
│          │  │ ⓘ Plan re-ran (revision 4): payroll is still funded. This payment is treated as   │   │
│          │  │   unavailable until Airwallex decides.                             View plan →    │   │
│          │  └───────────────────────────────────────────────────────────────────────────────────┘   │
│          │  3 questions · 2 ready · 1 needs you                                                     │
│          │ ┌──────────────── ANSWER (claims) ───────────────────┬────── SOURCES ─────────────────┐  │
│          │ │ 1. Purpose of payment                 [✓ Ready]    │ Invoice RD-2026-1180           │  │
│          │ │ "Describe what this payment is for."               │ inv-rhein-001 · page 1 of 1    │  │
│          │ │                                                    │ ✓ Quote verified               │  │
│          │ │ ① Payment for offset printing of catalogues ──[inv-│ ┌────────────────────────────┐ │  │
│          │ │   rhein-001 · p1]                                  │ │ Invoice number: RD-2026-   │ │  │
│          │ │ ② under invoice RD-2026-1180 dated 2026-09-19 ─────│ │ 1180  Invoice date:        │ │  │
│          │ │   [inv-rhein-001 · p1]                             │ │ 2026-09-19                 │ │  │
│          │ │ ③ for a total of EUR 7,200.00. ────────────────────│ │ ▓Total due: EUR 7,200.00▓  │ │  │
│          │ │   [inv-rhein-001 · p1]                             │ └────────────────────────────┘ │  │
│          │ │                                     [Edit answer]  │ Open document · sha 4be1…09aa  │  │
│          │ │────────────────────────────────────────────────────┼────────────────────────────────│  │
│          │ │ 2. Relationship with the counterparty   [✓ Ready]  │ Contract CT-NW-RD-2026         │  │
│          │ │ ① Rheinblick Druck GmbH is our supplier under ─────│ contract-rhein · page 1 of 2   │  │
│          │ │   contract CT-NW-RD-2026 [contract-rhein · p1]     │ "1. Parties: Northwind Studio  │  │
│          │ │ ② effective 2026-02-01. [contract-rhein · p1] ─────│ Ltd (Buyer) and Rheinblick ... │  │
│          │ │                                     [Edit answer]  │ "2. Effective date: 2026-02-01"│  │
│          │ │────────────────────────────────────────────────────┼────────────────────────────────│  │
│          │ │ 3. Source of funds  · attachment    [⚠ Needs you]  │ No grounded source.            │  │
│          │ │ Carnet found no document that shows where these    │ Carnet will not invent one.    │  │
│          │ │ funds came from. Attach one or write an answer.    │                                │  │
│          │ │ [Attach a document ▾]  [Write an answer]           │                                │  │
│          │ └────────────────────────────────────────────────────┴────────────────────────────────┘  │
│          │ ▸ Keyboard                                                                               │
│          │╔════════════════════════════════════════════════════════════════════════════════════════╗│
│          │║ ⚠ 1 question needs your answer → Q3          [ Approve and submit 3 answers ] (disabled)║│
│          │╚════════════════════════════════════════════════════════════════════════════════════════╝│
└──────────┴──────────────────────────────────────────────────────────────────────────────────────────┘
```

Grid at 1440: content column up to 1312px; header full width; question area is a two-column grid
`minmax(0, 7fr) minmax(0, 5fr)` with 24px gap. Each question is one grid **row**, so the sources for
a question always start level with that question (no floating panel that drifts out of alignment).
Within a row, each SourceSnippet is aligned with the first claim that cites it; when one question has
more snippets than fit, the sources cell stacks them in claim order. The ApprovalBar is sticky to the
bottom of the content column.

### Mobile wireframe (375)

```
┌─────────────────────────────────────┐
│ ← Queue            Live · 2 s ago ● │
│ Rheinblick Druck GmbH               │
│ EUR 7,200.00                        │
│ [⏸ Held for information]            │
│ [◌ Processing]                      │
│ Status stays Processing until       │
│ Airwallex decides.                  │
│ Answer by Thu 6 Nov 18:00 (26 h)    │
│ ▸ RFI details                       │
│ ┌─────────────────────────────────┐ │
│ │ⓘ Plan re-ran: payroll still     │ │
│ │  funded.          View plan →   │ │
│ └─────────────────────────────────┘ │
│ 3 questions · 2 ready · 1 needs you │
│─────────────────────────────────────│
│ 1. Purpose of payment    [✓ Ready]  │
│ ① Payment for offset printing of    │
│   catalogues                        │
│   [▤ inv-rhein-001 · p1 ✓]          │
│   ┌───────────────────────────────┐ │
│   │ Invoice RD-2026-1180 · p1     │ │
│   │ "Total due: EUR 7,200.00"     │ │
│   └───────────────────────────────┘ │
│ ② under invoice RD-2026-1180 …      │
│   [▤ inv-rhein-001 · p1 ✓]          │
│ [Edit answer]                       │
│─────────────────────────────────────│
│ 2. Relationship …        [✓ Ready]  │
│ …                                   │
│─────────────────────────────────────│
│ 3. Source of funds   [⚠ Needs you]  │
│ Carnet found no document …          │
│ [Attach a document]                 │
│ [Write an answer]                   │
│                                     │
│╔═══════════════════════════════════╗│
│║ 1 question needs you → Q3         ║│
│║ [Approve and submit 3 answers]    ║│
│╚═══════════════════════════════════╝│
│ [Queue] [Plan] [Ops]                │
└─────────────────────────────────────┘
```

At 375: one column. Each claim is followed directly by its CitationChip and, inline beneath it, a
compact SourceSnippet (quote clamped to 2 lines, cited span visible); "Open full source" opens a bottom
Sheet with the full snippet and "Open document". The ApprovalBar sits above the bottom tab bar, button
full width and 48px tall. Badges stack if they do not fit on one line.

### Tablet (768)

Single column like mobile, but each claim and its snippet sit side by side inside the question
(`1fr 1fr`), quotes clamped to 4 lines; the nav is the 64px icon rail; the ApprovalBar is one row.

## The source-snippet-next-to-claim layout

- The drafter's output is split into **claims**: the sentence-level spans that the verifier tied to
  fact citations (ADR 0010). Each claim is rendered as its own ClaimRow: a number marker (①②③ drawn as
  numbered circles in CSS, with "Claim 1" as accessible text), the claim text, and its CitationChip(s).
- Each citation resolves to one SourceSnippet: the **verbatim quote** from the document's text layer,
  the document's human title ("Invoice RD-2026-1180"), the document id (`inv-rhein-001`), "page 1 of 1",
  the verification state ("Quote verified" / "Confirmed by you"), and the cited span marked with `<mark>`.
- Desktop: the snippet sits in the right column on the same row as the claim, with a 1px `--border`
  connector line from the chip to the snippet's left edge (decorative; the relationship is also in
  `aria-controls`). Hovering or focusing a claim highlights its snippet (`--accent` fill) and vice versa.
- If several claims cite the same quote, one snippet is shown and lists "Cited by claims 2 and 3".
- Text in the answer that is not part of a claim (connective words) is plain text. **Every number,
  date and name in the answer is inside a claim**; that is what the verifier guarantees, and the layout
  makes it visible: a figure with no chip next to it should never appear.
- Attachment questions show the files that will be uploaded, each with its own snippet (the fact that
  makes it relevant: "2026-10-05 Credit EUR 8,400.00 from Altstadt Verlag GmbH …") and its hash.
- Reused answers (follow-up round) show "Reused from your approved answer in round 1, approved 4 Nov
  14:02" with the same claims and snippets.

## Approve / edit flow

1. **Arrival.** The RFI is fetched from Airwallex (webhook or 60 s poll). The screen shows the header
   immediately and, per question, "Drafting…" in the waiting pattern ("Carnet is drafting answers from
   your documents · started 14:01:40"). Drafts appear per question as each is stored (`DRAFT_READY`).
2. **Read.** Each question shows its draft and status:
   - `Ready`: every claim verified.
   - `Needs you` (NEEDS_OWNER): Carnet could not ground an answer (no document, verifier rejected the
     draft, image-only facts not yet confirmed, contradicting documents). The reason is shown in plain
     words ("No contract with Lakeside Freight is on file. Carnet will not invent one."). There is
     **no** model text to accept; the owner writes the answer or attaches a document.
   - `Reused`: an approved answer from an earlier round for the same normalised question.
3. **Edit a draft.** "Edit answer" turns the answer into a 16px Textarea pre-filled with the draft text.
   Claims are shown read-only beneath it as "Sources you can cite". On Save (`Ctrl/Cmd+Enter` or
   button) the server stores a **new** answer version (drafts are immutable) and re-runs the verifier
   (code only, no model call):
   - Figures, dates and names still found in the cited facts stay linked to their snippets.
   - Any figure, date or name that is not in a cited fact is marked inline with a warning icon and
     "Not found in your documents"; the question becomes `Edited by you`, labelled "Your statement",
     not "verified". The owner may still approve it (the owner is the source of their own statement),
     and the approval dialog lists every unverified statement explicitly.
   - "Discard edit" (AlertDialog) restores the drafted version.
4. **Answer a NEEDS_OWNER question.** For `TEXT`: write an answer (same Textarea, labelled "Your
   statement"). For `ATTACHMENT`: choose a document already in Carnet (list filtered to the
   counterparty and kind) or upload one (PDF, JPEG, PNG; 5 MB). The question becomes ready only when
   it has content the server accepted.
5. **NEEDS_OWNER blocks approval.** While any question has no answer, the ApprovalBar is `blocked`:
   "1 question needs your answer" linking to it; the button is `aria-disabled`. Airwallex rejects
   partial responses ("Please answer all questions in the request", observed in M0-04), so Carnet never
   offers to send a subset.
6. **Approve.** "Approve and submit 3 answers" opens the approval Dialog, which shows **exactly the
   content that will be sent**: each question title, the final answer text, each attachment name and
   hash, unverified statements (if any), the RFI id and round, and the content hash (short form, full
   on expand). It states: "This approval covers exactly this content. If anything changes, you will
   need to approve again. Airwallex reviews the answer and decides the transfer's outcome." Controls:
   "Approve and submit" (primary) and "Cancel".
7. **One bound approval.** On confirm, the client sends the content hash it displayed; the server
   re-derives the hash from current state (ADR 0008) and creates the approval only if they match. If
   they do not (a draft changed in another tab, a follow-up arrived), the server refuses and the dialog
   shows "The answers changed since you opened this. Review the changes and approve again." with the
   changed questions highlighted.
8. **Submit.** The executor consumes the approval atomically with the attempt and calls Airwallex. The
   ApprovalBar shows the waiting step list (Approved by you → Sent to Airwallex → Waiting for Airwallex
   to confirm). Draft editors are locked from approval until the outcome.
9. **Outcome.** When the server reports `ANSWERED`: "Answer submitted to Airwallex at 14:02. The
   transfer is still Processing; Airwallex decides the outcome." The question cards collapse to a
   read-only answered summary. The StatusBadge pair stays as Airwallex reports it.
10. **Editing after approval invalidates it.** If the owner edits any answer or attachment while an
    approval is `APPROVED` but not yet consumed (for example execution is paused by the kill switch),
    the server marks the approval invalid on the next hash check; the bar shows `invalidated`: "The
    answers changed after you approved. Approve again." Before the edit begins, the editor warns:
    "Editing will cancel your approval of 14:02."
11. **Follow-up round.** A `REOPENED` RFI returns to step 2 with round 2; reopened questions with an
    approved answer show `Reused` and need only the single new approval; new questions draft as usual.

## No optimistic updates

Money and approvals render **only server-confirmed state** (ADR 0017).

- The approve button goes to `pending` ("Submitting to Airwallex…", static spinner, `aria-busy`) and
  stays there until the server responds. It never shows a tick, "Approved" or "Submitted" before the
  server says so.
- "Approved by you" appears only when the approval row exists server-side. "Answer submitted" appears
  only when the RFI is `ANSWERED` from Airwallex (fetched, not inferred from our own request).
- The transfer StatusBadge never changes because of an RFI action. After `ANSWERED`, it still shows
  what Airwallex reports for the transfer (for example Processing); a later `SENT`/`PAID`/`FAILED`
  appears only from the transfer itself.
- Saving an edit shows "Saving…" until the server stores the version and returns the verifier result;
  only then do chips and warnings update. Unsaved text is labelled "Not saved".
- On error, the UI returns to the last confirmed state and shows what happened; it never leaves a
  half-done success visible.
- A timeout is not a failure: it becomes the `UNKNOWN` waiting state (lookup, never a resend).

## Components

AppShell, StatusBadge (held + transfer, `md`), MoneyDisplay (`hero`), LiveIndicator, Alert (plan
re-ran: default; injection flagged: warning; replay: default; errors: destructive), Card per question,
ClaimRow, CitationChip, SourceSnippet, Textarea, Button (`outline` "Edit answer", `secondary` "Write an
answer", primary in ApprovalBar), DropdownMenu ("Attach a document"), Dialog (bound approval),
AlertDialog (discard edit), Sheet (mobile source), Collapsible (earlier rounds, RFI details, keyboard
help), Skeleton, StaleBanner, ApprovalBar, Tooltip (absolute times, ids).

## States

### Loading

Shell and header skeleton (amount block, two badge blocks, deadline line) followed by three question
skeletons with a left text block and a right snippet block at final height. Visually hidden status:
"Loading the request for information". Initial data is server-fetched, so on in-app navigation this
state is brief.

### Empty

No open RFI for this payment (it was closed, or the link is old): "This payment has no open request
for information." plus the payment's current StatusBadge and "Back to the queue". If the RFI was
answered earlier, show the read-only answered summary instead of an empty state.

### Error

- RFI fetch failed: section error in place of the questions: "Carnet could not load this request from
  its database. Nothing was sent. Retry." Header still shows if the payment loaded.
- Drafting failed (model unavailable): affected questions become `Needs you` with the reason "Carnet
  could not draft this answer right now. You can write it yourself." (architecture §9 degradation).
- Approval refused (hash mismatch): handled in the dialog (step 7).
- Submit rejected by Airwallex (400): page-anchored destructive Alert with Airwallex's message
  verbatim in details, "Your approval was not used for anything else; review and approve again."
- Expired RFI: danger Alert "Airwallex closed this request on 〈date〉 because the deadline passed.
  Carnet cannot answer it now." Approval disabled.

### Stale

Transfer or RFI state not refreshed for 60 s: StaleBanner under the header ("Last update from
Airwallex 2 min ago. Carnet is retrying.") and the approve button is disabled with "Waiting for fresh
data from Airwallex". Drafts stay readable.

### Waiting for Airwallex

Two places: (a) before drafts exist, if the RFI webhook arrived but the fetch has not completed: "Request
received from Airwallex. Fetching the questions…"; (b) after approval, the step list in the
ApprovalBar, including the `UNKNOWN` copy ("Airwallex did not confirm in time. Carnet is looking the
request up; it will not send it twice.").

### Partial

One cited document fails to load its snippet: the claim shows "Source did not load" with Retry and
approval is blocked until it loads ("A cited source did not load. Reload before approving.").

## Interactions

- Polls the payment projection and RFI state every 3 s while visible; patches in place.
- CitationChip: scroll to and highlight snippet (desktop), open Sheet (mobile).
- Edit / Save / Discard per question; Attach a document; Write an answer.
- Approve → Dialog → confirm; Cancel returns focus to the button.
- "View plan" link to the Plan screen with the revision anchored.
- Copy buttons on RFI id, request id and hash.
- Earlier rounds expand read-only.

## Keyboard and accessibility

- Headings: `h1` counterparty + amount; `h2` "Questions from Airwallex"; `h3` per question ("Question 1
  of 3: Purpose of payment, ready").
- Questions are an `<ol>`; claims within an answer are an `<ol>` with `aria-label="Claims in this
  answer"`; each CitationChip has the accessible name "Source: invoice RD-2026-1180, page 1, quote
  verified" and `aria-controls` its snippet; the snippet has `aria-describedby` back to the claim.
- `Alt+↓/↑` jumps between questions; `Ctrl/Cmd+Enter` saves an edit (never approves).
- Approval dialog: focus on title; content is a reading-order summary; the confirm button's name
  includes the count ("Approve and submit 3 answers"); `Esc` ignored while pending with a visible note.
- ApprovalBar status text is `role="status"`; a failed submit is `role="alert"`.
- The sticky ApprovalBar sets `scroll-padding-bottom` so focused elements are never covered (2.4.11).
- Polling announcements: transfer status change, held flag change, RFI state change only.
- Mobile: all chips, buttons and the edit link are 44px tall; badges wrap.

## Strings keys used

- `hold.header.back`, `hold.header.amountLabel`, `hold.header.heldExplainer`, `hold.header.deadline`,
  `hold.header.deadlineRelative`, `hold.header.rfiId`, `hold.header.round`, `hold.header.rfiDetails`
- `hold.plan.revised`, `hold.plan.cta`
- `hold.summary.counts`
- `hold.questions.heading`, `hold.question.position`, `hold.question.answerTypeAttachment`
- `hold.question.statusReady`, `hold.question.statusNeedsOwner`, `hold.question.statusEdited`,
  `hold.question.statusReused`, `hold.question.drafting`
- `hold.needsOwner.noDocument`, `hold.needsOwner.verifierRejected`, `hold.needsOwner.imageOnly`,
  `hold.needsOwner.contradiction`, `hold.needsOwner.modelUnavailable`
- `hold.claim.label`, `hold.claim.unverified`, `hold.claim.yourStatement`, `hold.claim.citedBy`
- `hold.citation.name`, `hold.citation.verified`, `hold.citation.ownerConfirmed`,
  `hold.citation.notFound`
- `hold.source.page`, `hold.source.openDocument`, `hold.source.openFull`, `hold.source.showFullQuote`,
  `hold.source.noTextLayer`, `hold.source.none`, `hold.source.failed`, `hold.source.backToClaim`
- `hold.edit.cta`, `hold.edit.save`, `hold.edit.saving`, `hold.edit.discard`,
  `hold.edit.discardConfirm`, `hold.edit.sourcesYouCanCite`, `hold.edit.cancelsApproval`
- `hold.answer.write`, `hold.answer.attach`, `hold.answer.upload`, `hold.answer.uploadHint`
- `hold.reuse.label`
- `hold.approval.cta`, `hold.approval.ctaCount`, `hold.approval.ctaPending`, `hold.approval.blocked`,
  `hold.approval.readySummary`, `hold.approval.hash`, `hold.approval.approvedWaiting`,
  `hold.approval.submitted`, `hold.approval.invalidated`, `hold.approval.expired`,
  `hold.approval.killSwitch`, `hold.approval.staleDisabled`
- `hold.dialog.title`, `hold.dialog.body`, `hold.dialog.boundNotice`, `hold.dialog.unverifiedList`,
  `hold.dialog.confirm`, `hold.dialog.cancel`, `hold.dialog.pendingNoEsc`, `hold.dialog.hashMismatch`
- `hold.outcome.answered`, `hold.outcome.transferUnchanged`
- `hold.empty.title`, `hold.empty.body`, `hold.empty.cta`
- `hold.error.load`, `hold.error.submitRejected`, `hold.error.expired`, `hold.error.injectionFlagged`
- `hold.loading.status`, `hold.waiting.fetching`, `hold.earlierRounds.label`, `hold.keyboard.label`,
  `hold.keyboard.body`
- `status.held.label`, `status.held.hint`, `status.transfer.processing.label`,
  `status.transfer.sent.label`, `status.transfer.paid.label`, `status.transfer.failed.label`
- `common.state.stale.title`, `common.state.stale.body`, `common.state.stale.checkNow`,
  `common.state.waiting.approved`, `common.state.waiting.sent`, `common.state.waiting.confirming`,
  `common.state.waiting.unknown`, `common.state.waiting.slow`, `common.state.partial.approvalBlocked`,
  `common.state.unsaved`, `common.time.checkedAgo`, `common.action.copy`, `common.action.copied`
