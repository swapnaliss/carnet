---
title: "M1-07 · Design system + hero-screen specs (ux-designer) + app shell, strings module"
milestone: "M1 · Walking Skeleton"
labels: ["frontend"]
blocked_by: ["M0-GATE"]
estimate: "6h"
resources: []
needs: ["P-10"]
---

## Context

PROJECT.md §7 (UX design workflow): M1-07 produces the design system and the hero-screen specs; every
later `frontend` ticket builds to `docs/design/` and passes the independent `ui-reviewer`. ADR 0017
fixes the stack (App Router, Tailwind 4, shadcn, a typed strings module with `Intl`), the targets
(LCP < 2.5 s, INP < 200 ms, CLS < 0.1, WCAG 2.2 AA), loading/empty/error states on every screen, and
no optimistic updates on money or approvals. The hold screen is the hero (R4 demo arc, R3 approvals
stated visibly); this ticket specifies it, M2-08 builds it.

## Scope

1. **Run the `ux-designer` agent** (`.claude/agents/ux-designer.md`) and commit its output to
   `docs/design/`:
   - `tokens.md` (+ `tokens.css`): color (light and dark, contrast ratios computed), type scale,
     spacing, radius, elevation, motion (reduced-motion rules)
   - `components.md`: the shadcn components used, variants, and Carnet-specific components (status
     badge for the projection views including the held flag, money display, citation chip, source
     snippet, approval bar, stale banner)
   - `states.md`: loading, empty, error, stale-data and "waiting for Airwallex" patterns
   - `accessibility.md`: WCAG 2.2 AA notes, focus order, keyboard map, live-region rules for polling
     updates, target sizes
   - `performance.md`: Core Web Vitals budgets per screen and how each is measured
   - Specs for the five screens: `screens/payment-queue.md`, `screens/evidence-view.md`,
     `screens/hold-screen.md` (hero; the wireframe from PROJECT.md/the dossier made concrete),
     `screens/plan-screen.md`, `screens/ops.md`
2. **App shell** in `apps/web`: Tailwind 4.3.3 + shadcn configured with the tokens, root layout, nav
   shell (queue, plan, ops placeholders linking to empty-state pages), skip link, theme support
   (light/dark by `prefers-color-scheme`), error and not-found pages.
3. **Strings module** `apps/web/src/strings.ts`: typed (`as const` object, `en`), no inline user-facing
   literals in components (a lint/test enforces it for the shell), plus `Intl` helpers
   `formatMoney(Money, locale)`, `formatDate`, `formatRelative` that accept the domain `Money`
   (M1-01) and never use floating point.
4. This ticket passes the `ui-reviewer` design review (independent agent, not the builder) and
   builds to `docs/design/`; the review verdict is posted on the issue.

## Out of scope

- Building the five screens (their owning tickets: M2-03, M2-08, M3-04, M1-09 for ops data)
- Real data wiring, auth UI polish beyond restyling the M1-04 login with the tokens
- A second locale

## Acceptance Criteria

- [ ] All files listed under Deliverables exist and the five screen specs each contain: purpose, data shown, layout, all states (loading/empty/error/stale), keyboard and a11y notes, and the strings keys used
- [ ] `hold-screen.md` shows the wireframe, the approve/edit flow, the no-optimistic-update rule and the source-snippet-next-to-claim layout
- [ ] Token contrast: a script (`npm run design:contrast`) verifies every text/background token pair meets WCAG AA (4.5:1 body, 3:1 large/UI) in light and dark and exits non-zero otherwise
- [ ] The app shell builds (`npm run build -w apps/web`) and an automated axe check (Playwright + axe-core) on `/login`, the shell home, and an empty-state page reports zero serious or critical violations
- [ ] Lighthouse (or Playwright web-vitals) run on the shell home against a production build meets LCP < 2.5 s and CLS < 0.1 on the CI profile; the numbers are recorded in `docs/design/performance.md`
- [ ] Strings test: no JSX text literal outside `strings.ts` in `apps/web/src/components` and `app` shell files; `formatMoney` tests cover USD, JPY (exponent 0), EUR in `en-US` and `en-GB`
- [ ] `ui-reviewer` returns PASS (or all findings fixed and re-reviewed); verdict and screenshots (light, dark, mobile 375 px, desktop) posted on the issue
- [ ] `npm run typecheck -w apps/web` and `npm run test -w apps/web` exit 0

## Deliverables

- `docs/design/{tokens.md,tokens.css,components.md,states.md,accessibility.md,performance.md}`
- `docs/design/screens/{payment-queue,evidence-view,hold-screen,plan-screen,ops}.md`
- `apps/web/src/{strings.ts,lib/intl.ts}`, `apps/web/src/app/{layout,error,not-found,page}.tsx`, `apps/web/src/components/*`
- `apps/web/components.json`, Tailwind config, `scripts/design-contrast.ts`
- `apps/web/test/{strings,intl}.test.ts`, `apps/web/e2e/shell.a11y.spec.ts`
- `.env.example`: no new keys

## Validation Gate

```bash
set -euo pipefail
test -f docs/design/screens/hold-screen.md
for s in payment-queue evidence-view hold-screen plan-screen ops; do test -s "docs/design/screens/$s.md"; done
npm run design:contrast
npm run typecheck -w apps/web
npm run test -w apps/web
npm run build -w apps/web
npx playwright test apps/web/e2e/shell.a11y.spec.ts
./scripts/check-no-secrets.sh
```

## Handoff

M1-08 (shell and tokens for the skeleton UI), M2-03, M2-08, M3-04, M3-06, M4-05, M4-07 (every
`frontend` ticket builds to `docs/design/` and passes the `ui-reviewer`). Comment on the issue: the
design file index, the strings-key naming convention, the Intl helper signatures, the performance
budgets, and the `ui-reviewer` verdict. Hot file: `apps/web/src/strings.ts` (add keys, never reorder).
