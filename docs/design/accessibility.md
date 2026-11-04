# Accessibility

Target: **WCAG 2.2 AA** on every screen, checked by axe (Playwright + `@axe-core/playwright`, zero
serious or critical violations) and by the `ui-reviewer`. M4-07 adds a manual keyboard and screen-reader
pass (NVDA + Firefox, VoiceOver + Safari iOS).

## WCAG 2.2 AA notes that shape Carnet

| Criterion | How Carnet meets it |
|---|---|
| 1.3.1 Info and relationships | Tables are real `<table>` with `<th scope>`; the hold screen's question list is an `<ol>`; each claim and its snippet are linked with `aria-controls` / `aria-describedby`; headings are hierarchical (one `h1` per page) |
| 1.4.1 Use of colour | StatusBadge, EvidenceStrength, CitationChip states, plan deltas: icon + label + colour. Current nav item: `aria-current` + fill + left rule |
| 1.4.3 / 1.4.11 Contrast | Verified by `npm run design:contrast` against `tokens.md`; focus ring, borders and inputs ≥ 3:1 |
| 1.4.4 / 1.4.10 Resize and reflow | Usable at 320px and 400% zoom; tables become stacked rows below 768px; no horizontal scroll except inside the document preview |
| 1.4.12 Text spacing | No fixed-height text containers; badges grow with text |
| 1.4.13 Content on hover or focus | Tooltips open on focus, are dismissible with `Esc`, and stay while hovered |
| 2.1.1 Keyboard | Every action, including citation jumps and the approval dialog, works with keyboard only |
| 2.4.1 Bypass blocks | Skip link to `<main id="main">` |
| 2.4.3 Focus order | DOM order equals visual order; see below |
| 2.4.7 / 2.4.11 Focus visible, not obscured | 2px `--focus-ring` outline with 2px offset on every focusable element; the sticky ApprovalBar and bottom nav reserve `scroll-padding-bottom` so a focused element is never hidden under them |
| 2.5.7 Dragging movements | No drag interactions anywhere |
| 2.5.8 Target size (minimum) | 24×24 CSS px minimum everywhere; 44×44 below 768px and under `(pointer: coarse)` |
| 3.2.2 On input | Choosing an attachment or editing a draft never submits; approval needs an explicit button and a dialog |
| 3.3.1 / 3.3.3 Error identification and suggestion | Inline errors name the field and the fix |
| 3.3.4 Error prevention (legal, financial) | Every money or answer submission is reviewable before it is sent (the approval dialog shows exactly what will be sent) and is confirmed explicitly |
| 3.3.7 Redundant entry | An approved answer is offered for reuse in a follow-up round; the owner never retypes it |
| 3.3.8 Accessible authentication | Login accepts password managers and paste; no cognitive puzzle |
| 4.1.3 Status messages | Live-region rules below |

## Focus order

Global: skip link → header (wordmark, then business name and user menu when present) → nav → main
content → ApprovalBar (if present) → bottom tab bar (mobile).

Per screen, main content in this order:
- **Queue:** page title → goal summary → held payment callout → filters → table (row by row, link
  first in each row) → pagination.
- **Evidence view:** back link → title and payment summary → tabs (Documents, Checks) → tab panel →
  actions.
- **Hold screen:** back link → header (amount, counterparty, badges, RFI deadline) → "plan re-ran"
  note → question 1 (title, draft, claims, chips, edit) → question 2 … → sources column for the active
  question (desktop: after each question's claims in DOM order, positioned beside them) → ApprovalBar.
- **Plan:** title → summary (funded/unfunded) → actions needing approval → auto-executed actions →
  obligations table → revision history.
- **Ops:** title → kill-switch controls → health tiles → tabs.

Focus management rules:
- Route change: focus moves to the page `h1` (`tabindex="-1"`), announced by the router announcer.
- Dialog open: focus to the dialog title; close: focus returns to the trigger.
- CitationChip activation: focus moves to the SourceSnippet heading; "Back to claim" returns it.
- **Polling never moves focus** and never re-renders the element that has focus (keys are stable;
  updated rows are patched in place).
- After a successful server-confirmed approval, focus moves to the ApprovalBar status text, which is
  the confirmation the user needs.

## Keyboard map

Standard keys only. Carnet ships **no** single-character shortcuts (they clash with screen-reader
keys, WCAG 2.1.4); the two custom shortcuts below both use a modifier.

| Key | Where | Action |
|---|---|---|
| `Tab` / `Shift+Tab` | Everywhere | Move between focusable elements in the order above |
| `Enter` | Link, row link, CitationChip | Activate |
| `Space` | Button, checkbox, CitationChip | Activate / toggle |
| `←` `→` | Tabs | Move between tabs (Radix roving focus); `Home`/`End` first/last |
| `↑` `↓` | Radio groups, menus | Move selection |
| `Esc` | Tooltip, menu, sheet, dialog | Close; the approval dialog ignores `Esc` while its request is pending (the request cannot be cancelled once sent; the dialog explains this) |
| `Ctrl/Cmd+Enter` | Draft textarea | Save the edit (same as the Save button); never approves |
| `Alt+↓` / `Alt+↑` | Hold screen, inside a question | Jump to next / previous question heading (also reachable by screen-reader heading navigation; the shortcut is a convenience and is listed in a visible "Keyboard" disclosure) |

## Live regions for polling updates

Screens poll every 3 s (architecture §6). Without rules this would flood a screen reader.

1. **One polite live region per page**, in the shell (`<div role="status" aria-live="polite"
   aria-atomic="true" class="sr-only">`). Components push messages to it through a small hook;
   components do not create their own live regions (except the two below).
2. **Announce transitions, not polls.** A message is pushed only when a value the user cares about
   changes: a transfer status, the held flag, an RFI state, an attempt state, a plan revision. "Checked
   3 s ago" is never announced.
3. **Message shape:** object + new state + source. "Rheinblick Druck, EUR 7,200.00: Airwallex reports
   Sent, not yet paid." "Request for information received for Rheinblick Druck. Drafting answers."
4. **Debounce:** at most one announcement per 2 s; if several changes arrive together, combine them
   ("3 payments changed status. Rheinblick Druck is held for information.").
5. **Assertive (`role="alert"`) only** for: a failure of an action the user just started (approval
   submit failed), the kill switch turning on while the user is on an action screen, and a `PAID →
   FAILED` incident. Nothing else is assertive.
6. The ApprovalBar status text is its own `role="status"` region so pending → submitted is announced
   where the user's focus is.
7. Hidden tabs (`document.hidden`) stop polling; on return the page fetches once and announces only
   the net change since the user left.

## Target sizes

| Context | Minimum | Notes |
|---|---|---|
| Default (≥ 768px, fine pointer) | 24×24 CSS px, or 24px spacing around smaller targets | Table row links use full cell height (≥ 40px) |
| Below 768px or `(pointer: coarse)` | 44×44 CSS px | Buttons `lg`; badges that are links sit in a 44px row; CitationChips get 44px height via padding; bottom nav items 44px+ |
| Inline text links | Exempt (2.5.8 inline exception) but line-height 1.5 keeps them separable | |

## Other rules

- `lang="en"` on `<html>`; counterparty names in other languages keep `lang` only when known (not
  required in the synthetic set).
- Icons are `aria-hidden="true"` when next to a text label; icon-only buttons (copy, close) have an
  accessible name from `strings.ts`.
- Amounts: the accessible name is the full formatted string with currency code.
- Times use `<time datetime="ISO">`; relative times have the absolute time in the accessible
  description.
- Document previews are PDFs opened as attachments; the hold screen never depends on the PDF being
  accessible, because the cited text is on the page as real text.
- Reduced motion honoured as in `tokens.md`; nothing flashes more than 3 times per second.
