# M4-07: accessibility and Core Web Vitals

| | |
|---|---|
| Date | 2026-11-15 |
| Commit | branch `feat/m4-07-a11y-cwv-15-11-2026` (PR body names the final commit) |
| URL class | **local production build** (`next build` + `next start`, port 5400, local Postgres seeded with the e2e fixtures). **Not the hosted app.** The hosted run is still owed before the M4 gate (Scope 5). |
| Browser | Playwright Chromium (Playwright 1.64.1), `@axe-core/playwright` 4.14.0 |
| Data | `apps/web/e2e/fixtures/seed-hold.ts` and `seed-plan.ts`: real pipeline output over recorded responses. No Airwallex or model call was made. |

Everything below was measured on this run. Nothing is carried over from earlier tickets.

## 1. Axe: every route and state

Spec: `apps/web/e2e/a11y/axe.spec.ts`. Tags: `wcag2a wcag2aa wcag21a wcag21aa wcag22a wcag22aa`. The bar is **zero violations of any impact**, which is stricter than the earlier "no serious or critical" bar. Excluded rules: **none** (`EXCLUDED_RULES` in `apps/web/e2e/a11y/support.ts` is empty).

The route list is checked against the App Router tree by `apps/web/e2e/a11y/route-table.spec.ts`. It fails when a `page.tsx` (or a `route.ts` outside `api/` that serves HTML) has no axe case, when a listed route no longer exists, or when a listed state has no case. `/healthz` is excluded because it is a JSON probe.

**Result: 72 of 72 passed (36 states × light and dark), with 0 violations** (final run on this branch, after every fix).

| Route | States (each run in light and dark) |
|---|---|
| `/` | home |
| `/login` | login (no session) |
| `/queue` | with payments; loading (`/queue/preview-loading`); error (`/queue/preview-error`) |
| `/payments` | new payment form |
| `/payments/[id]` | payment detail with the payee-link panel |
| `/payments/[id]/evidence` | evidence view; loading; error |
| `/rfis` | list; empty; error |
| `/rfis/[id]` (hold screen) | drafted; NEEDS_OWNER; edited; approve dialog open (with the bound-content disclosure); approved (waiting); answered; expired; model unavailable; orphan (link to payment); kill switch on |
| `/rfis-loading-preview` | hold loading skeleton |
| `/plan` | empty (no session) |
| `/plans/current`, `/plans/[revision]` | current plan; revision 1 |
| `/plans/*-preview` | loading; error; all action states |
| `/ops` | owner view, including the kill-switch panel |
| `/error-preview` | page-level error |
| `/status/[token]` | payee status (no cookies); link not available |
| not-found, forbidden | unknown path; viewer on `/ops` (403) |

**Judge replay mode (M4-05), follow-up run on 2026-11-15:** M4-05 added `/replay` and `/replay/payee`, and `route-table.spec.ts` failed on both until they had cases. There are 6 new states, each run in light and dark:
- `/replay` with the recording banner (judge)
- `/replay` with the LIVE indicator (owner)
- `/replay` after stepping the timeline to step 3 (judge)
- `/replay/payee`, the payee view of the recording (judge)
- `/queue` in a replay session, with the banner in context (judge)
- the hold screen in a replay session (judge)

The database was prepared with `npm run demo:reset -- --yes` (fixtures/replay/m2) plus the e2e seeds. **Result: 84 of 84 axe checks passed (42 states × light and dark) with 0 violations.** No fixes were needed. The whole `apps/web/e2e/a11y` directory now passes 101 tests: 84 axe, 2 route-table, 2 status-not-colour, 10 focus, 2 keyboard and 1 lazy-load.

## 2. Keyboard-only path through the hold screen

Spec: `apps/web/e2e/a11y/keyboard.spec.ts`. Only Tab, Shift+Tab, Enter, Space, Escape, End and the arrow keys are used. There is no click and no programmatic focus. A capture-phase listener counts `pointerdown`, `mousedown` and non-keyboard `click`; the count was **0**.

The test walks this path:
1. From `/queue`, Tab to the held payment's "Review and answer" link and press Enter.
2. The hold screen opens with focus on the `h1`.
3. Tab into the question navigator. ArrowDown and Enter jump to each question in turn, and each question heading takes focus.
4. Tab to "Show full quote" and press Enter. The verbatim snippet opens.
5. Tab to "Edit answer" and press Enter. Tab to the draft and edit it. Tab to "Save edit" and press Space.
6. Tab to approve and press Enter. Focus is on the dialog title. Escape returns focus to the trigger.
7. Press Enter again, Tab to "Approve and submit 4 answers" and press Enter.
8. Focus is on the approval status message, which reads "Approved by you".

**Result: passed.** The visible focus indicator was checked at every stop, about 150 per run: an outline or ring of at least 2 px, with at least 3:1 contrast against what is behind it (colours normalised through a canvas). Every stop passed.

The tab-order test walks every focusable element on the hold screen. It wraps back to the start with no trap, and fewer than 20% of steps move upward (side-column snippets). **Result: passed.**

## 3. Focus management

Spec: `apps/web/e2e/a11y/focus.spec.ts`. **Result: 10 of 10 passed.**
- The approve dialog takes focus on its title. Escape and Cancel both return focus to the trigger.
- After a server-confirmed approval, focus moves to the approval status message (`role="status"`).
- A poll update (DRAFTING to DRAFT_READY) does not move focus: the focused element and its markup are unchanged. The update is announced in the shell's polite live region (`#live-region`, `aria-live="polite"`).
- A failed approval submit is announced through `role="alert"`, so it is assertive.
- A heading focused by the question navigator, or after saving an edit, sits fully below the sticky header at 375, 768 and 1440 (WCAG 2.4.11).
- The hold screen has one `h1`, one `main`, a banner and the "Main" navigation. The skip link is the first tab stop and moves focus to `main`.

## 4. Contrast and colour

- `apps/web/test/contrast.test.ts` (vitest): **97 of 97 passed**. Every pair in the `contrast-pairs` block of `docs/design/tokens.md` (47 pairs) is checked in light and dark against `docs/design/tokens.css`. Thresholds are 4.5:1 for body text and 3:1 for large text and UI. The test also proves that the list is complete: every `--x-foreground` is paired with `--x`, and every `--status-*-fg` with its `--status-*-bg`. A separate check shows the focus ring is at least 3:1 against the page in both themes.
- `apps/web/e2e/a11y/status-not-colour.spec.ts`: **2 of 2 passed**. On the queue and the hold screen, every StatusBadge, EvidenceStrength and Held badge, and the hold-screen badges, have a text label and an `aria-hidden` icon. "Held for information" is checked by name.

## 5. Core Web Vitals

Script: `scripts/cwv.ts` (Playwright and PerformanceObserver, no extra service). Budgets are judged on the **median**: LCP < 2.5 s, INP < 200 ms, CLS < 0.1.

Profiles:
- **mobile:** 375×812 touch, CPU ×4, 150 ms RTT, 1.6 Mbit/s down
- **desktop:** 1440×900, CPU ×1, 40 ms RTT, 10 Mbit/s

"Cold" is a new context with the HTTP cache disabled. "Warm" is the second load in one context with the cache on. There are 5 runs per group. INP comes from Event Timing entries during scripted hold-screen interactions: expand a citation's full quote, open the approve dialog, close it with Escape.

| Route | Profile | Cache | LCP median (worst) | CLS median (worst) | INP median (worst) | Within budget |
|---|---|---|---|---|---|---|
| `/queue` | mobile | cold | 1612 ms (1900) | 0 (0) | n/a (no scripted interaction) | yes |
| `/queue` | mobile | warm | 1124 ms (1292) | 0 (0) | n/a (no scripted interaction) | yes |
| `/queue` | desktop | cold | 864 ms (1048) | 0 (0) | n/a (no scripted interaction) | yes |
| `/queue` | desktop | warm | 684 ms (872) | 0 (0) | n/a (no scripted interaction) | yes |
| `/rfis/[id] (hold screen)` | mobile | cold | 1264 ms (2368) | 0 (0) | 256 ms (616) | **no** |
| `/rfis/[id] (hold screen)` | mobile | warm | 2176 ms (2668) | 0 (0) | 576 ms (696) | **no** |
| `/rfis/[id] (hold screen)` | desktop | cold | 504 ms (720) | 0 (0) | 96 ms (160) | yes |
| `/rfis/[id] (hold screen)` | desktop | warm | 592 ms (712) | 0 (0) | 88 ms (136) | yes |
| `/plans/current` | mobile | cold | 1748 ms (2100) | 0 (0) | n/a (no scripted interaction) | yes |
| `/plans/current` | mobile | warm | 2152 ms (2828) | 0 (0) | n/a (no scripted interaction) | yes |
| `/plans/current` | desktop | cold | 568 ms (808) | 0 (0) | n/a (no scripted interaction) | yes |
| `/plans/current` | desktop | warm | 676 ms (744) | 0 (0) | n/a (no scripted interaction) | yes |
| `/payments/[id]/evidence` | mobile | cold | 1608 ms (1688) | 0 (0) | n/a (no scripted interaction) | yes |
| `/payments/[id]/evidence` | mobile | warm | 1284 ms (2536) | 0 (0) | n/a (no scripted interaction) | yes |
| `/payments/[id]/evidence` | desktop | cold | 256 ms (564) | 0 (0) | n/a (no scripted interaction) | yes |
| `/payments/[id]/evidence` | desktop | warm | 124 ms (156) | 0 (0) | n/a (no scripted interaction) | yes |

**Result: 14 of 16 groups are within budget. The mobile hold screen misses INP (median 256 ms cold, 576 ms warm) and the gate fails on that item. LCP and CLS are within budget everywhere (CLS 0 on every run).** `--assert` exited 1. This is the local run of 2026-11-15 after the fixes in section 6.

Why the mobile hold screen misses INP, measured with a local Event Timing and long-task probe (`.review/M4-07/inp-probe.ts`, CPU ×4):
- The script interacts as soon as the server-rendered hold screen is visible, which is before React has finished hydrating. The first tap then waits for hydration: one tap measured `pointerdown` 192 ms, with 133 ms of processing spent hydrating. A CPU profile of the first 2.5 s shows about 360 ms of parse and compile ("program") and about 150 ms of module instantiation in the Turbopack runtime. That is framework start-up, not Carnet's handlers.
- Once the page is interactive, the same three interactions measured 48-80 ms each in the same probe (expand quote 72 ms, open dialog 56 ms, Escape 56 ms). These probe numbers are separate from the table above and are not part of `--assert`.
- Before the poll fix (section 6), opening the dialog took 184 ms and a poll landing during a tap blocked it for 226-375 ms. The first local run, before any fix, measured mobile hold-screen INP medians of 1168 ms (cold) and 624 ms (warm).

What is left to fix: reduce the hold screen's client JavaScript at hydration (for example, load the approve dialog and the answer editor with `next/dynamic`), then re-measure. This is logged on BL-01. The hosted run is also still owed.

Earlier local runs on the same day (kept for honesty):
- Run 1 overlapped with the screenshot capture and is discarded.
- Run 2 was before the poll and queue fixes: `/queue` mobile LCP medians were 1776/2096 ms, and the hold screen's mobile INP medians were 1168/624 ms.


### Raw runs (5 per group; LCP ms, CLS, INP ms)
| Route | Profile | Cache | Run | LCP | CLS | INP |
|---|---|---|---|---|---|---|
| `/queue` | mobile | cold | 1 | 1772 | 0 |  |
| `/queue` | mobile | cold | 2 | 1900 | 0 |  |
| `/queue` | mobile | cold | 3 | 1612 | 0 |  |
| `/queue` | mobile | cold | 4 | 1536 | 0 |  |
| `/queue` | mobile | cold | 5 | 1540 | 0 |  |
| `/queue` | mobile | warm | 1 | 1084 | 0 |  |
| `/queue` | mobile | warm | 2 | 1124 | 0 |  |
| `/queue` | mobile | warm | 3 | 1160 | 0 |  |
| `/queue` | mobile | warm | 4 | 1048 | 0 |  |
| `/queue` | mobile | warm | 5 | 1292 | 0 |  |
| `/queue` | desktop | cold | 1 | 816 | 0 |  |
| `/queue` | desktop | cold | 2 | 1048 | 0 |  |
| `/queue` | desktop | cold | 3 | 760 | 0 |  |
| `/queue` | desktop | cold | 4 | 864 | 0 |  |
| `/queue` | desktop | cold | 5 | 900 | 0 |  |
| `/queue` | desktop | warm | 1 | 552 | 0 |  |
| `/queue` | desktop | warm | 2 | 728 | 0 |  |
| `/queue` | desktop | warm | 3 | 872 | 0 |  |
| `/queue` | desktop | warm | 4 | 660 | 0 |  |
| `/queue` | desktop | warm | 5 | 684 | 0 |  |
| `/rfis/[id] (hold screen)` | mobile | cold | 1 | 1036 | 0 | 256 |
| `/rfis/[id] (hold screen)` | mobile | cold | 2 | 1052 | 0 | 160 |
| `/rfis/[id] (hold screen)` | mobile | cold | 3 | 1264 | 0 | 304 |
| `/rfis/[id] (hold screen)` | mobile | cold | 4 | 1724 | 0 | 232 |
| `/rfis/[id] (hold screen)` | mobile | cold | 5 | 2368 | 0 | 616 |
| `/rfis/[id] (hold screen)` | mobile | warm | 1 | 2240 | 0 | 576 |
| `/rfis/[id] (hold screen)` | mobile | warm | 2 | 1800 | 0 | 432 |
| `/rfis/[id] (hold screen)` | mobile | warm | 3 | 2176 | 0 | 584 |
| `/rfis/[id] (hold screen)` | mobile | warm | 4 | 2068 | 0 | 696 |
| `/rfis/[id] (hold screen)` | mobile | warm | 5 | 2668 | 0 | 448 |
| `/rfis/[id] (hold screen)` | desktop | cold | 1 | 448 | 0 | 160 |
| `/rfis/[id] (hold screen)` | desktop | cold | 2 | 384 | 0 | 72 |
| `/rfis/[id] (hold screen)` | desktop | cold | 3 | 720 | 0 | 160 |
| `/rfis/[id] (hold screen)` | desktop | cold | 4 | 576 | 0 | 96 |
| `/rfis/[id] (hold screen)` | desktop | cold | 5 | 504 | 0 | 72 |
| `/rfis/[id] (hold screen)` | desktop | warm | 1 | 496 | 0 | 88 |
| `/rfis/[id] (hold screen)` | desktop | warm | 2 | 712 | 0 | 136 |
| `/rfis/[id] (hold screen)` | desktop | warm | 3 | 352 | 0 | 88 |
| `/rfis/[id] (hold screen)` | desktop | warm | 4 | 692 | 0 | 56 |
| `/rfis/[id] (hold screen)` | desktop | warm | 5 | 592 | 0 | 72 |
| `/plans/current` | mobile | cold | 1 | 1524 | 0 |  |
| `/plans/current` | mobile | cold | 2 | 2100 | 0 |  |
| `/plans/current` | mobile | cold | 3 | 1712 | 0 |  |
| `/plans/current` | mobile | cold | 4 | 1988 | 0 |  |
| `/plans/current` | mobile | cold | 5 | 1748 | 0 |  |
| `/plans/current` | mobile | warm | 1 | 1696 | 0 |  |
| `/plans/current` | mobile | warm | 2 | 1900 | 0 |  |
| `/plans/current` | mobile | warm | 3 | 2216 | 0 |  |
| `/plans/current` | mobile | warm | 4 | 2152 | 0 |  |
| `/plans/current` | mobile | warm | 5 | 2828 | 0 |  |
| `/plans/current` | desktop | cold | 1 | 436 | 0 |  |
| `/plans/current` | desktop | cold | 2 | 808 | 0 |  |
| `/plans/current` | desktop | cold | 3 | 568 | 0 |  |
| `/plans/current` | desktop | cold | 4 | 492 | 0 |  |
| `/plans/current` | desktop | cold | 5 | 580 | 0 |  |
| `/plans/current` | desktop | warm | 1 | 604 | 0 |  |
| `/plans/current` | desktop | warm | 2 | 632 | 0 |  |
| `/plans/current` | desktop | warm | 3 | 744 | 0 |  |
| `/plans/current` | desktop | warm | 4 | 676 | 0 |  |
| `/plans/current` | desktop | warm | 5 | 700 | 0 |  |
| `/payments/[id]/evidence` | mobile | cold | 1 | 1580 | 0 |  |
| `/payments/[id]/evidence` | mobile | cold | 2 | 1644 | 0 |  |
| `/payments/[id]/evidence` | mobile | cold | 3 | 1688 | 0 |  |
| `/payments/[id]/evidence` | mobile | cold | 4 | 1572 | 0 |  |
| `/payments/[id]/evidence` | mobile | cold | 5 | 1608 | 0 |  |
| `/payments/[id]/evidence` | mobile | warm | 1 | 1284 | 0 |  |
| `/payments/[id]/evidence` | mobile | warm | 2 | 1680 | 0 |  |
| `/payments/[id]/evidence` | mobile | warm | 3 | 2536 | 0 |  |
| `/payments/[id]/evidence` | mobile | warm | 4 | 544 | 0 |  |
| `/payments/[id]/evidence` | mobile | warm | 5 | 916 | 0 |  |
| `/payments/[id]/evidence` | desktop | cold | 1 | 256 | 0 |  |
| `/payments/[id]/evidence` | desktop | cold | 2 | 256 | 0 |  |
| `/payments/[id]/evidence` | desktop | cold | 3 | 252 | 0 |  |
| `/payments/[id]/evidence` | desktop | cold | 4 | 260 | 0 |  |
| `/payments/[id]/evidence` | desktop | cold | 5 | 564 | 0 |  |
| `/payments/[id]/evidence` | desktop | warm | 1 | 108 | 0 |  |
| `/payments/[id]/evidence` | desktop | warm | 2 | 124 | 0 |  |
| `/payments/[id]/evidence` | desktop | warm | 3 | 156 | 0 |  |
| `/payments/[id]/evidence` | desktop | warm | 4 | 152 | 0 |  |
| `/payments/[id]/evidence` | desktop | warm | 5 | 96 | 0 |  |


### Follow-up run (2026-11-15, after M4-05 merged): hydration JavaScript trimmed

What changed:
- The approve dialog was already wrapped in `next/dynamic`, but the hold screen imported `makeSnapshot` from `approve-dialog.tsx`, so the dialog stayed in the first-load bundle. The snapshot now lives in `approve-snapshot.ts`, so the dialog really loads on first use.
- The answer editor (`edit-answer.tsx`) now loads with `next/dynamic` when it is first opened.
- `apps/web/e2e/a11y/hold-lazy.spec.ts` proves that neither module is in the hold screen's first-load scripts, that each arrives when it is first opened, and that both still work by keyboard.

How it was measured: `scripts/cwv.ts --runs 5 --assert` on a fresh local database (demo reset plus the e2e seeds), local production build, the same machine, nothing else running. This database is smaller than the one behind the run above, so the two runs are not like-for-like. A baseline at `origin/main` **without** this change was measured on the same database, so the before and after below are comparable.

| Hold screen, mobile | Baseline: `origin/main` a3cdd2b, same DB | With the lazy dialog and editor |
|---|---|---|
| INP cold, median (worst) | 72 ms (80) | 48 ms (64) |
| INP warm, median (worst) | 96 ms (112) | 88 ms (104) |
| LCP cold, median (worst) | 880 ms (936) | 904 ms (916) |
| LCP warm, median (worst) | 748 ms (780) | 732 ms (816) |

**Result with the change: 16 of 16 groups are within budget, and `--assert` exited 0.** The full table is below. The baseline also passed 16 of 16 on this database. So the earlier miss (median 256 ms cold and 576 ms warm) was **not reproduced** on today's `main` with a fresh database, even without this change. The run above used a larger database (several seed rounds) and a different RFI, and that is the likely difference. This was not isolated further. The lazy loading lowers mobile INP a little (median 72 → 48 ms cold, 96 → 88 ms warm), and the earlier probe saw a first tap before hydration drop from 192 ms to 88–104 ms.

| Route | Profile | Cache | LCP median (worst) | CLS median (worst) | INP median (worst) | Within budget |
|---|---|---|---|---|---|---|
| `/queue` | mobile | cold | 884 ms (912) | 0 (0) | n/a (no scripted interaction) | yes |
| `/queue` | mobile | warm | 648 ms (676) | 0 (0) | n/a (no scripted interaction) | yes |
| `/queue` | desktop | cold | 276 ms (348) | 0 (0) | n/a (no scripted interaction) | yes |
| `/queue` | desktop | warm | 580 ms (616) | 0 (0) | n/a (no scripted interaction) | yes |
| `/rfis/[id] (hold screen)` | mobile | cold | 904 ms (916) | 0 (0) | 48 ms (64) | yes |
| `/rfis/[id] (hold screen)` | mobile | warm | 732 ms (816) | 0 (0) | 88 ms (104) | yes |
| `/rfis/[id] (hold screen)` | desktop | cold | 276 ms (308) | 0 (0) | 48 ms (72) | yes |
| `/rfis/[id] (hold screen)` | desktop | warm | 248 ms (456) | 0 (0) | 48 ms (56) | yes |
| `/plans/current` | mobile | cold | 900 ms (912) | 0 (0) | n/a (no scripted interaction) | yes |
| `/plans/current` | mobile | warm | 680 ms (704) | 0 (0) | n/a (no scripted interaction) | yes |
| `/plans/current` | desktop | cold | 284 ms (336) | 0 (0) | n/a (no scripted interaction) | yes |
| `/plans/current` | desktop | warm | 460 ms (484) | 0 (0) | n/a (no scripted interaction) | yes |
| `/payments/[id]/evidence` | mobile | cold | 816 ms (832) | 0 (0) | n/a (no scripted interaction) | yes |
| `/payments/[id]/evidence` | mobile | warm | 684 ms (692) | 0 (0) | n/a (no scripted interaction) | yes |
| `/payments/[id]/evidence` | desktop | cold | 240 ms (324) | 0 (0) | n/a (no scripted interaction) | yes |
| `/payments/[id]/evidence` | desktop | warm | 92 ms (436) | 0 (0) | n/a (no scripted interaction) | yes |

These are still local numbers. The hosted run is still owed before the gate.

## 6. Fixes made in this ticket (each has a test)

| Fix | File | Test |
|---|---|---|
| Route-change focus waits for the streamed page `h1` when a `loading.tsx` skeleton shows first. Before this fix, the queue → hold screen navigation left focus nowhere. It does not steal focus if the person has already moved it. | `apps/web/src/components/shell/route-focus.tsx` | keyboard.spec.ts (h1 focused after Enter on the queue link) |
| After a confirmed approval, focus moves to the approval status message (spec rule; this was missing) | `apps/web/src/components/rfi/approval-bar.tsx` | focus.spec.ts "after a confirmed approval…" |
| Question headings and the dialog title had `outline-none`, so the focus stop was invisible. They now show the global focus ring. | `question-card.tsx`, `approve-dialog.tsx` | keyboard.spec.ts focus-indicator check at every stop |
| Closing the answer editor (save or cancel) removed the focused control and dropped focus to `body`. Focus now returns to the question heading. | `apps/web/src/components/rfi/question-card.tsx` | keyboard.spec.ts (no stop lands on body mid-page), focus.spec.ts header test |
| Focused elements scroll clear of the sticky header with `scroll-padding-top` (WCAG 2.4.11; ui-reviewer blocking items 1 and 2) | `apps/web/src/app/globals.css` | focus.spec.ts "focused question headings are not hidden under the sticky header" |
| The 3 s poll now keeps the identity of unchanged data (structural sharing), and question cards ignore the per-poll `server_time`. An unchanged poll therefore no longer re-renders every card, and opening the dialog no longer re-renders them either. Measured INP on the mobile hold screen fell from medians of 1168 ms (cold) and 624 ms (warm) to 256 ms and 576 ms. That is still over budget; see section 5. | `apps/web/src/components/payments/use-poll.ts`, `apps/web/src/components/rfi/question-card.tsx` | `apps/web/src/components/payments/use-poll.test.ts`; `scripts/cwv.ts` |
| The queue now loads its per-payment evidence checks concurrently instead of one after another. Mobile `/queue` LCP medians went from 1776 ms (cold) and 2096 ms (warm) to 1612 ms and 1124 ms. | `apps/web/src/server/queue.ts` | `scripts/cwv.ts`; axe "queue with payments" |

## 7. Limitations and residual items (BL-01)

- Only automated checks and a scripted keyboard walk were run. There was no manual screen-reader pass (NVDA, VoiceOver); that is out of scope for this ticket.
- CWV was measured on a local production build, not the hosted app. The hosted run (`npx tsx scripts/cwv.ts --url "$DEPLOY_URL" --runs 5 --assert`) is still owed before the gate.
- Judge replay mode (M4-05) is covered since the follow-up run (section 1).
- **Mobile hold-screen INP:** it missed the budget in the first run (256 ms cold, 576 ms warm). In the follow-up run it is within budget on a fresh database, both before (72 ms cold, 96 ms warm) and after (48 ms cold, 88 ms warm) the lazy-loading change. The earlier miss was not reproduced, and the hosted run is still owed (section 5). BL-01 comment 6891327363.
- Hold-screen polish from the ui-reviewer (identical citation chips, the "Edited by you" tone, spec drift, the nav-rail label edges at 768, the dialog footer at 375, focus-ring spacing): BL-01 comment 6891157470.
- Seed answers that do not match the seeded payment header: BL-01 comment 6891157727.

## Hosted run (2026-11-15, owed by Scope 5)

`npx tsx scripts/cwv.ts --url https://carnet-web.onrender.com --runs 5 --assert` against the deployed app at `ee254af` (Render, Singapore), measured from one client machine. Raw output: [`cwv-hosted.json`](cwv-hosted.json). **16 of 16 route/profile/cache groups within budget on the median; `--assert` exited 0.**

| Route | Profile | LCP median (worst) | CLS median (worst) | INP median (worst) |
|---|---|---|---|---|
| /queue | mobile cold / warm | 1760 (2384) / 1252 (1404) ms | 0.0004 / 0 | n/a |
| /queue | desktop cold / warm | 1548 (2228) / 1448 (2396) ms | 0 / 0 | n/a |
| hold screen | mobile cold / warm | 1284 (1296) / 692 (764) ms | 0 (0.0013) / 0 | **168 (224) / 184 (240) ms** |
| hold screen | desktop cold / warm | 532 (1352) / 672 (796) ms | 0 (0.0008) / 0 | 64 (80) / 48 (72) ms |
| /plans/current | mobile cold / warm | 1248 (1356) / 716 (796) ms | 0.0025 / 0 | n/a |
| /plans/current | desktop cold / warm | 516 (800) / 600 (892) ms | 0.0005 / 0 | n/a |
| /payments/[id]/evidence | mobile cold / warm | 1196 (1280) / 644 (836) ms | 0 / 0 | n/a |
| /payments/[id]/evidence | desktop cold / warm | 504 (504) / 604 (624) ms | 0.0038 (0.0126) / 0 | n/a |

- **Mobile hold-screen INP is within budget on the median but close to it**, and the worst run of each profile is over 200 ms (224 ms cold, 240 ms warm). Budgets are judged on the median (performance.md), so this passes, narrowly. It is the one number to watch.
- The hold screen measured is an RFI whose draft was DRAFT_READY: it was created for this purpose by running steps 1-4 of `demo-live.spec.ts` live just before. A first hosted run that same afternoon opened a CLOSED RFI, where the scripted interactions do not exist and INP read 0 ms; that run is discarded, not reported.
- One run of 5 samples per group from one network location; the service was already warm, so a cold start is not included.
