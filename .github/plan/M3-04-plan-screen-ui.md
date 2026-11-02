---
title: "M3-04 · Plan screen UI (before/after, actions, approvals)"
milestone: "M3 · Hold-Aware Planning"
labels: ["frontend", "backend"]
blocked_by: ["M3-01", "M3-02"]
estimate: "7h"
resources: []
needs: ["P-10"]
---

## Context

The owner must see why the plan changed when a payment was held, and must approve exactly what the plan says. This screen is the visible half of rubric R2 (the decision changes with new information) and R6 (approvals bound to the content shown), and the place where ADR 0011's "contract-derived criticality is a proposal; the owner confirms" becomes a control. It builds to `docs/design/` (design system and hero-screen specs from M1-07) and must pass the independent `ui-reviewer` design review in `/start`. ADR 0017: server components for plan pages, client components for approval controls, no optimistic updates on money or approvals, strings in the typed module, `Intl` for money and dates, WCAG 2.2 AA, loading, empty and error states.

## Scope

1. **Plan page** `/plans/current` (and `/plans/[revision]`): header with revision number, `inputs_hash` short form, and the trigger that caused it ("payment to <payee> held for information"). **Before/after**: two columns (previous revision and current) for balances per currency (available, held shown as unavailable, reserve floor, projected after plan), and obligations with their fate (funded, deferred to date, escalated). Differences are marked in text as well as colour.
2. **Action list**: each plan action (fund, convert, defer, escalate, payout) with its amounts in the right currency, its machine reason rendered via the strings module, and its **approval state**: PROPOSED (needs approval), APPROVED, AUTO_APPROVED (shows "within policy v<N>, hash <short>" and the limit headroom), EXECUTING, DONE, FAILED, SUPERSEDED. Payout and out-of-policy conversion actions have an approve control.
3. **Explanation text generated from plan facts**: a deterministic template renderer in `packages/domain/src/planner/explain.ts` builds the paragraph ("Payroll of EUR 4,200.00 is funded by converting USD 4,812.30 ...") from `reason_facts` only, with no model call (ADR 0009 keeps the three typed model calls only). A verifier function `verifyExplanation(text, plan)` extracts every number, currency and date in the text and checks each against the plan facts; a mismatch hides the text and shows the raw reasons. Property test: any mutation of a number in the rendered text is rejected.
4. **Criticality confirmation control**: on each obligation row, the proposal (value, rationale, verbatim quote and page from M3-01) beside a control to confirm or override; confirming calls `POST /obligations/{id}/criticality/confirm`; unconfirmed obligations show "Unconfirmed, treated as most protective" (the M3-02 rule). The control is disabled for viewers; no pre-selected value.
5. **Bound approvals**: the approve button posts the approval for the exact action content rendered (payout: source account, beneficiary fingerprint, amount, currency, fee option, value date, reference, counterparty; conversion: pair, amount, rate bounds, per ADR 0008); the page stores the shown snapshot (`approvals.shown_snapshot`) and the server re-derives the hash. If the plan revision changed since the page loaded, the approve call fails with a clear "plan changed, review again" state and the page refreshes; the old approval cannot be used.
6. **Live updates**: the page polls (the same interval the hold screen uses) and shows "Plan revised <time>" when a new revision lands; no optimistic state on money or approvals.
7. **API**: `GET /api/v1/plans/current`, `GET /api/v1/plans/{revision}`, `POST /api/v1/plan-actions/{id}/approve` (Idempotency-Key, server-side role check, scoped by `business_id`).
8. **States and quality**: loading skeleton, empty ("No obligations yet"), error with retry, stale banner when Airwallex was unreachable; keyboard operable; focus order and aria labels; LCP < 2.5 s, INP < 200 ms, CLS < 0.1 recorded for the page; Playwright component/e2e test against recorded plan fixtures and an axe check.

## Out of scope

- Executing actions (M3-03); computing plans (M3-02); the proposal itself (M3-01).
- The hold screen (M2-08) and its follow-up addition (M3-05); the payee page (M3-06).
- Any model-written explanation, any external notification.

## Acceptance Criteria

- [ ] The page renders the payroll-Friday fixture revision pair (M3-02) and shows the before and after balances per currency with held funds marked unavailable, and the convert, fund, payout and defer actions (Playwright test with screenshots saved under `$TMPDIR`).
- [ ] Every number, currency and date in the explanation text is found in the plan facts; a unit test that alters any one figure makes `verifyExplanation` fail and the UI falls back to raw reasons.
- [ ] Approving a payout from the page produces an approval whose hash covers the fields shown; changing the displayed amount in the DB between render and click makes the approve call fail (integration test).
- [ ] After a new plan revision, an approval click for the old revision is refused and the page shows "plan changed".
- [ ] Confirming criticality calls the confirm endpoint and the obligation row shows the confirmer; a viewer sees the control disabled; before confirmation the row says Unconfirmed.
- [ ] No prose in components: all strings come from `apps/web/src/strings.ts`; money and dates use `Intl` (lint rule or test grep).
- [ ] axe reports no serious or critical violations; the page is fully operable by keyboard (Playwright test); loading, empty and error states each have a test.
- [ ] The page was built to `docs/design/` and the `ui-reviewer` design review passed, with its verdict recorded on the PR.

## Deliverables

- `apps/web/src/app/plans/`, components, `apps/web/src/app/api/v1/plans/`, `apps/web/src/app/api/v1/plan-actions/`
- `packages/domain/src/planner/explain.ts` and tests; strings additions in `apps/web/src/strings.ts` (hot file)
- Playwright specs `apps/web/e2e/plan-screen.spec.ts`, fixtures under `fixtures/planner/`

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; OUT="$(mktemp -d "$TMPDIR/m3-04.XXXXXX")"
npx vitest run packages/domain/src/planner/explain apps/web/src/app/plans apps/web/src/app/api/v1/plans 2>&1 | tee "$OUT/unit.log"
TEST_DATABASE_URL="${TEST_DATABASE_URL:?set a throwaway database}" npx vitest run apps/web/src/app/api/v1/plan-actions
npm run build -w apps/web
npx playwright test apps/web/e2e/plan-screen.spec.ts --output "$OUT/pw"
! grep -rnE '>[A-Z][a-z]+ [a-z]+ [a-z]+' apps/web/src/app/plans --include='*.tsx'   # no literal prose in components
./scripts/landing-checks.sh --fast
```

## Handoff

- **M3-07** drives this page in the live e2e (convert auto-executed shown as AUTO_APPROVED, payout approved here).
- **M4-05** replays a recorded plan on this page for the judge login; **M4-07** audits it for accessibility and Web Vitals.
Post as an issue comment: routes and API paths, the design-review verdict, the Web Vitals numbers measured, the strings keys added, and how `verifyExplanation` is wired so the replay mode can reuse it.
