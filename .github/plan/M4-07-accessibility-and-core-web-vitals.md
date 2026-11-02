---
title: "M4-07 · Accessibility + Core Web Vitals pass"
milestone: "M4 · Governance & Evals"
labels: ["frontend"]
blocked_by: ["M4-05"]
estimate: "5h"
resources: []
needs: []
---

## Context

[ADR 0017](../../docs/adr/0017-frontend-app-router-and-strings.md) fixes the targets: LCP < 2.5 s, INP < 200 ms, CLS < 0.1, WCAG 2.2 AA, loading, empty and error states on every screen. R8/R9 judges experience the product through its UI; a hold screen that cannot be used with a keyboard, or that jumps around, undermines the "approval you can trust" claim. `CLAUDE.md`: build to `docs/design/`. This ticket is blocked by M4-05 so the replay routes (which judges will actually see) exist and are included.

This ticket builds to `docs/design/` and must pass the independent `ui-reviewer` design review.

## Scope

1. **Axe in Playwright** on every screen and state: login, queue, payment detail, evidence view, hold screen (each answer state: drafted, NEEDS_OWNER, edited, approved), plan screen, payee page, `/ops`, owner kill-switch panel, replay mode with banner, empty, loading and error states. Uses `@axe-core/playwright`; verify the current version on npm and pin it exactly on the day. Rules: WCAG 2.0/2.1/2.2 A and AA tags; zero violations, any exclusion listed with justification in the test file.
2. **Keyboard-only path** through the hold screen: from the queue to opening an RFI, reading each question, reviewing citations and source snippets, editing a draft, approving and submitting, using only Tab, Shift+Tab, Enter, Space, Escape and arrow keys where the design specifies; visible focus indicator (>= 2 px, 3:1 contrast) at every stop; no keyboard trap; tab order matches reading order.
3. **Focus management:** on route change, dialog open/close (return focus to the trigger), after approve/submit (focus moves to the status message), on async updates from the 3 s poll (no focus theft; updates announced through a polite live region, errors assertive), skip-to-content link, one `h1` per page, landmarks.
4. **Contrast per tokens:** a test computes contrast for every foreground/background token pair in `docs/design/` in light and dark (if both exist) and asserts AA (4.5:1 text, 3:1 large text and UI components); status is never conveyed by colour alone (HELD FOR INFORMATION has text and icon).
5. **Core Web Vitals measured on the deployed app** (hosted environment URL from the deployment ticket; production build, not dev) for the key routes, cold and warm, with a mid-tier mobile profile and a desktop profile: LCP, INP (via scripted interactions: open hold screen, expand citation, approve dialog) and CLS, 5 runs each, median and worst reported. Budgets: LCP < 2.5 s, INP < 200 ms, CLS < 0.1. If the hosted URL is unavailable, measure a local production build and record that in the file and flag it for the gate; the hosted run must be completed before the gate.
6. **Fix what fails** (markup, labels, focus, image sizes, font loading, layout reservations, bundle/route splitting); each fix has a test. Anything needing design changes goes through the `ux-designer` spec in `docs/design/` and is noted in the PR.
7. **Results file** `docs/evidence/a11y-cwv.md` (tracked): date, commit, URL class (hosted or local), axe results per screen, keyboard path walk-through result, contrast table summary, CWV table against budgets, fixes made, residual items logged to `BL-01`.

## Out of scope

- Screen-reader recordings or manual testing with specific assistive technology beyond the automated and keyboard checks (note as a limitation in the results file).
- Localisation (single locale; strings module and `Intl` only).
- Redesign of screens (spec changes only through `docs/design/`).
- Load testing (M4-06).

## Acceptance Criteria

- [ ] Axe run covers every route and state listed in Scope 1 and reports zero A/AA violations; the route list is derived from the app's route table by a test that fails when a new route has no axe test
- [ ] The keyboard-only Playwright test completes the hold-screen path (open RFI, review, edit, approve, submit) with no pointer events, and asserts visible focus at each step
- [ ] Focus-management tests: dialog returns focus to trigger; post-approve focus on the status message; polling update does not move focus and is announced via a live region
- [ ] Contrast test passes for all design token pairs; no information is conveyed by colour alone (test on status components)
- [ ] CWV for key routes meet LCP < 2.5 s, INP < 200 ms, CLS < 0.1 (median) on the hosted app, with raw runs in the results file; any budget miss is fixed or the gate fails
- [ ] `docs/evidence/a11y-cwv.md` exists with the sections in Scope 7
- [ ] `ui-reviewer` design review passes against `docs/design/`
- [ ] `./scripts/landing-checks.sh` passes

## Deliverables

- `apps/web/e2e/a11y/*.spec.ts`, keyboard-path spec, contrast test, CWV measurement script (`scripts/cwv.ts`, Playwright + `web-vitals` or PerformanceObserver; no new service)
- Fixes in `apps/web`
- `docs/evidence/a11y-cwv.md`
- Pinned `@axe-core/playwright` in the web workspace dev dependencies

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"
docker compose up -d db web worker
npm run db:migrate
npx playwright test apps/web/e2e/a11y
npx vitest run apps/web/test/contrast.test.ts
test -n "${DEPLOY_URL:-}"   # hosted URL, set by the caller (no value recorded here)
npx tsx scripts/cwv.ts --url "$DEPLOY_URL" --runs 5 --out "$TMPDIR/cwv.json" --assert
test -f docs/evidence/a11y-cwv.md
./scripts/landing-checks.sh
```

## Handoff → M4-GATE, M5-01

Comment on the issue: axe result summary, CWV medians against budgets, whether the CWV run was hosted or local, and residual items in `BL-01`. The gate requires the evidence file; M5-01 cites accessibility and performance claims only from `docs/evidence/a11y-cwv.md`.
