# Evidence view

Built by M2-03 (server component with a small client island for tabs and citation jumps). Route
(proposed): `/payments/[paymentId]/evidence`.

## Purpose

Show, for one payment, whether the documents support it **before** it moves: which documents are
linked, what facts Carnet extracted (each with its verbatim quote and page), which evidence checks
passed or failed, and what the owner must do (confirm facts from an image-only scan, resolve a
contradiction, add a missing document). Pillar 1, evidence-first payments. From here the owner approves
and sends a payment with strong evidence.

## Data shown

| Data | Source | Notes |
|---|---|---|
| Payment summary | `payments`, `counterparties`, `obligations` | Counterparty, amount, due date ("Not set" until obligations exist, M3), method (LOCAL / SWIFT), beneficiary account fingerprint as stored ("Not recorded yet" until a beneficiary exists), StatusBadge pair |
| Evidence strength + reason | evidence rules | "Evidence weak: invoice total does not match the purchase order" |
| Checks | evidence rules results (M2-03, `packages/domain/src/evidence`) | Amount matches invoice (R-AMT) · Payee matches the invoice supplier (R-PAYEE) · A contract names the payee, first payment above the threshold (R-CONTRACT) · Facts are verified (R-VERIFIED) · Invoice and purchase order agree and Beneficiary account matches the contract (R-CONSISTENT, a rule beyond the ticket's four, owner decision 2026-11-11) · Contract in force on the invoice date and Funds evidence present, shown as "Not checked" because no rule runs them yet. Each row: pass / fail / not checked, the sentence with the two values, and a citation chip per document |
| Documents | `documents`, `evidence_links` | Title, kind, filename, pages, uploaded at, SHA-256 short, text layer yes/no, injection flag |
| Facts per document | `document_facts` (current version) | Field, value, verbatim quote, page, verified / needs confirmation / confirmed by you, fact version |
| Injection flag | pre-scan | "This document contains text that looks like instructions to an AI. Carnet treated it as data and did not follow it." with the flagged line in a quote |

## Layout (375 / 768 / 1440)

- **1440:** back link; header row: h1 counterparty + MoneyDisplay + StatusBadge pair; EvidenceStrength
  with its reason sentence; then Tabs: **Checks** (default when a check failed) and **Documents**.
  Checks tab: a Table: Check | Result (icon + label) | Compared (two values each with a CitationChip) |
  Action. Documents tab: two columns: document list (left, 360px) and the selected document's facts
  (right): each fact row = field label, value (mono for identifiers, MoneyDisplay for amounts), and its
  SourceSnippet inline. Primary action at the header right: "Approve and send" (offered whatever the strength while no transfer exists: owner decision 2026-11-11, issue M2-03: a Weak or Missing payment is sent only after an explicit acknowledgement in the approval dialog, audited as `evidence_override`), opening the payout approval dialog. Beyond the spec: the dialog lists what Carnet knows (payee, account, amount, reference) and says "Set by Airwallex" for the fee and value date, which are not known before the transfer exists.
- **768:** same, document list collapses into a select above the facts.
- **375:** one column; Checks as stacked cards (result first); Documents as an accordion per document;
  the primary action in a bottom bar above the tab bar (44px+).

## Components

AppShell, StatusBadge, MoneyDisplay, EvidenceStrength, Tabs, Table, Card, CitationChip, SourceSnippet,
Alert (injection: warning; contradiction: warning), Button, Dialog (payout approval: shows source
account, beneficiary fingerprint, amount, currency, fee option, value date, reference; ADR 0008),
Checkbox (confirm a fact from an image-only scan), Skeleton, StaleBanner.

## States

### Loading

Header skeleton, tab bar, 5 check-row skeletons. Status text "Loading evidence".

### Empty

No documents linked: "No documents are linked to this payment. Carnet cannot check it until you add
the invoice and, if there is one, the contract." CTA "Add a document" (M2-01). Evidence strength shows
`missing`. "Approve and send" is still offered (owner decision 2026-11-11, following the issue M2-03): it opens the payout approval, which asks for an acknowledgement of the reasons shown; the server refuses the send without it and records an `evidence_override` audit entry holding those reasons.

### Error

Section error per tab ("Carnet could not load the checks. Nothing was changed. Retry."). Extraction
failed for one document: that document shows "Carnet could not read this document" with the reason and
"Try again"; its facts are absent, and checks that need them show "Not checked" (neutral), never "pass".

### Stale

Extraction still running for a document (job pending): the document row shows "Reading document…"
with the LiveIndicator; checks that depend on it show "Waiting for document". Transfer status older than
60 s: StaleBanner; "Approve and send" disabled with the reason.

### Waiting for Airwallex

After approving a payout: the waiting step list replaces the primary action (Approved by you → Sent to
Airwallex → Waiting for Airwallex to confirm). The StatusBadge updates only when the transfer is
fetched.

## Interactions

- Tabs (URL hash `#checks` / `#documents`).
- CitationChip in a check jumps to the fact in the Documents tab (switches tab, focuses the snippet).
- "Confirm" on an image-only fact: checkbox per fact + "Confirm 2 facts" button; server-confirmed only.
- "Open document" downloads/opens the PDF (served as attachment).
- "Approve and send" → payout approval dialog → pending → waiting pattern.

## Keyboard and accessibility

- `h1` counterparty and amount; tabs follow the Radix pattern (arrows, Home/End).
- Check results: icon + "Passed" / "Failed" / "Not checked" text; never colour alone.
- Compared values read as "Invoice total EUR 9,450.00 from invoice RD-2026-1233 page 1; purchase order
  total EUR 6,900.00 from PO-NW-2026-061 page 1" (accessible name assembled from parts).
- Injection flag Alert is `role="status"` on load (not assertive).
- Image-only confirmation checkboxes have labels naming the field and value.

## Strings keys used

- `evidence.title`, `evidence.back`, `evidence.strength.strong`, `evidence.strength.weak`,
  `evidence.strength.missing`, `evidence.strength.needsConfirmation`, `evidence.strength.reason`
- `evidence.tabs.checks`, `evidence.tabs.documents`
- `evidence.check.amountMatchesInvoice`, `evidence.check.beneficiaryMatchesContract`,
  `evidence.check.invoiceMatchesPo`, `evidence.check.contractInForce`, `evidence.check.fundsEvidence`,
  `evidence.check.passed`, `evidence.check.failed`, `evidence.check.notChecked`,
  `evidence.check.notApplicable`, `evidence.check.waitingDocument`, `evidence.check.compared`
- `evidence.document.kind`, `evidence.document.pages`, `evidence.document.noTextLayer`,
  `evidence.document.reading`, `evidence.document.readFailed`, `evidence.document.retry`,
  `evidence.document.open`
- `evidence.fact.verified`, `evidence.fact.needsConfirmation`, `evidence.fact.confirmedByYou`,
  `evidence.fact.confirmCta`, `evidence.fact.confirmCtaPending`
- `evidence.injection.title`, `evidence.injection.body`
- `evidence.contradiction.title`, `evidence.contradiction.body`
- `evidence.approve.cta`, `evidence.approve.ctaPending`, `evidence.approve.dialogTitle`,
  `evidence.approve.dialogBody`, `evidence.approve.boundNotice`, `evidence.approve.disabledWeak`
- `evidence.empty.title`, `evidence.empty.body`, `evidence.empty.cta`
- `evidence.error.checks`, `evidence.error.documents`, `evidence.loading.status`
- `common.state.stale.title`, `common.state.stale.body`, `common.state.stale.actionsDisabled`,
  `common.state.waiting.approved`, `common.state.waiting.sent`, `common.state.waiting.confirming`
