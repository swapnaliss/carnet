# Performance

Targets from ADR 0017 and CLAUDE.md: **LCP < 2.5 s, INP < 200 ms, CLS < 0.1** at most, on every screen.
Several screens have tighter budgets because they are light. Numbers below are budgets, not
measurements; measured values are recorded per screen by the ticket that builds it.

## Budgets per screen

| Screen | Route | LCP element (expected) | LCP | INP | CLS | JS (route, gzip) | Interactions measured for INP |
|---|---|---|---|---|---|---|---|
| Shell home | `/` | `h1` + intro paragraph | < 1.8 s | < 100 ms | < 0.05 | ≤ 90 KB first load | Nav link click, skip link |
| Login | `/login` | Form title | < 1.8 s | < 100 ms | < 0.05 | ≤ 110 KB | Type in email, submit |
| Payment queue | `/queue` | Goal summary heading or first table row | < 2.0 s | < 150 ms | < 0.05 | ≤ 130 KB | Filter toggle, row link |
| Evidence view | `/payments/[id]/evidence` | Payment summary heading | < 2.2 s | < 150 ms | < 0.05 | ≤ 140 KB | Tab switch, CitationChip |
| **Hold screen** | `/payments/[id]/hold` | Hero amount + status badges in the header | < 2.5 s | < 200 ms | < 0.1 | ≤ 180 KB (client component) | CitationChip jump, open edit, type in draft (per-keystroke), open approval dialog |
| Plan screen | `/plan` | Plan summary heading | < 2.2 s | < 200 ms | < 0.05 | ≤ 160 KB | Expand action, open payout approval dialog |
| Ops | `/ops` | Health tile row | < 2.5 s | < 200 ms | < 0.1 | ≤ 150 KB | Tab switch, kill-switch toggle dialog |
| Payee status page | `/status/[token]` | Status sentence | < 1.5 s | < 100 ms | < 0.05 | ≤ 60 KB | None (read-only) |

Rules that keep the budgets:
- Server components for queue, evidence, plan and ops (ADR 0017); the hold screen is a client component
  hydrated with server-fetched initial data (no client-side first fetch, no loading flash on navigation).
- Fonts through `next/font` (self-hosted, `display: swap`, metric-adjusted fallback); no third-party
  requests at all (no analytics, no CDN fonts).
- Skeletons match final dimensions; StaleBanner and replay/kill-switch banners render server-side in
  reserved slots; polled updates patch text in place and never insert content above the viewport.
- No charts library on any route; ops sparklines, if any, are inline SVG.
- Polling uses `fetch` with `AbortController` and a 3 s interval only while the tab is visible; each
  poll response is small (state and timestamps, not full documents).
- Draft editing debounces the server save (500 ms) and keeps keystroke handlers trivial so typing INP
  stays under 50 ms.

## How it is measured

**Where:** a production build served by `next start` (never `next dev`), in CI and locally:
`npm run build -w apps/web && npm run start -w apps/web`.

**Tool:** Playwright (Chromium) with the `web-vitals` library injected via `page.addInitScript`
(attribution build), falling back to raw `PerformanceObserver` entries:
- LCP: `largest-contentful-paint` entries, final value taken on the first user input or page hide.
- CLS: `layout-shift` entries without `hadRecentInput`, session-windowed (web-vitals `onCLS`).
- INP: `event` entries with `durationThreshold: 16`, driven by scripted interactions (listed per screen
  above); web-vitals `onINP` with `reportAllChanges: true`, read after the last interaction plus a
  `visibilitychange` to flush.

**CI profile** (fixed so runs are comparable):
- Viewport 1440×900 for desktop and 375×812 (`isMobile`, `hasTouch`) for mobile; both are run.
- CPU throttling 4× via CDP `Emulation.setCPUThrottlingRate`.
- Network via CDP `Network.emulateNetworkConditions`: 150 ms latency, 1.6 Mbps down, 750 Kbps up
  ("Fast 4G"-like), cache disabled for the first navigation.
- 5 runs per screen and viewport; the recorded value is the **median**, the gate uses the **worst of
  the 5** against the budget for LCP and CLS (INP uses the median, since scripted input timing varies).
- Data: the seeded synthetic dataset (Northwind Studio) at demo scale; the hold screen uses the
  `rfi-set-rhein-followup` round 1 fixture (3 questions).

Lighthouse CI may be used as a cross-check, but the Playwright numbers are the recorded ones.

Each screen ticket records results in a table in its own section below, in the same format: date,
commit, viewport, LCP median/worst, CLS median/worst, INP median, pass/fail.

## Measured: shell home

Measured by `apps/web/e2e/shell.vitals.spec.ts` (raw `PerformanceObserver` entries; the `web-vitals`
library is not installed yet) on the CI profile above, against `next build` + `next start`, on the
M1-07 branch (on top of `9948646`), 4 Nov 2026, local Linux machine, Chromium from Playwright 1.64.1.

| Date | Commit | Viewport | LCP median / worst | CLS median / worst | INP median | Result |
|---|---|---|---|---|---|---|
| 2026-11-04 | M1-07 branch (`9948646`+) | 375×812 mobile | 1064 ms / 1096 ms | 0.0000 / 0.0000 | not measured | pass (< 1.8 s, < 0.05) |
| 2026-11-04 | M1-07 branch (`9948646`+) | 1440×900 desktop | 704 ms / 1052 ms | 0.0042 / 0.0042 | not measured | pass (< 1.8 s, < 0.05) |
| 2026-11-04 | M1-07 branch, after design review fixes | 375×812 mobile | 756 ms / 868 ms | 0.0000 / 0.0000 | not measured | pass (< 1.8 s, < 0.05) |
| 2026-11-04 | M1-07 branch, after design review fixes | 1440×900 desktop | 1060 ms / 1072 ms | 0.0020 / 0.0041 | not measured | pass (< 1.8 s, < 0.05) |

INP is not measured in M1-07: the shell has no interaction beyond links (the ticket's AC covers LCP and
CLS only). The first ticket with a client interaction (M2-08 hold screen) adds the INP measurement.
The spec fails if the worst run exceeds the shell-home budget, so a regression fails the run.
