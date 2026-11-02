---
title: "M2-08 · Hold screen UI (questions, drafts, citations, source snippets, approve/edit, polling)"
milestone: "M2 · Evidence to Answer"
labels: ["frontend"]
blocked_by: ["M2-05", "M2-07", "M1-07"]
estimate: "8h"
resources: []
needs: []
---

## Context

This is the hero screen: the 1:30 moment of the storyboard (R4) where the owner sees what Airwallex asked, what Carnet drafted, the document passage behind every claim, and gives one bound approval (R6). The wireframe in PROJECT.md §2 and the specs in `docs/design/` (M1-07) govern. The screen must make the safety logic visible: a claim without a verified source cannot be approved, and a `NEEDS_OWNER` question blocks the whole RFI with the reason shown, because respond needs every question answered.

This is a `frontend` ticket: it builds to `docs/design/` (M1-07) and passes the independent `ui-reviewer` design review.

## Scope

1. **Route** `/rfis/[id]` (hold screen) plus an RFI list with the orphan / account-level queue (`/rfis`), reading the M2-04 / M2-05 / M2-06 / M2-07 APIs.
2. **Layout**: questions on the left (title, description, answer type, state chip: Drafted, Needs you, Reused); on the right the draft answer for the selected question, its citations, and next to each claim the **source snippet** (verbatim quote, document name, page, verification badge: quote verified / owner confirmed). Attachment questions show the selected documents with name, size and sha256 prefix.
3. **Actions**: Approve (one approval for the whole RFI, showing exactly what will be submitted: all answers, attachments, expiry time), Edit (creates a new draft through the M2-05 path, verifier result shown before approval), Skip is available only as "leave for later" (never submits partial answers; explains that every question must be answered). Approve is disabled with an explanation when any question is `NEEDS_OWNER`, when the draft is stale, or when the approval would outlive the RFI.
4. **NEEDS_OWNER explanation**: reason code to plain language from the strings module (no source, claim not in cited facts, model unavailable, unsupported answer type, stale reuse), listing which question blocks the RFI and what the owner can do (write the answer, attach a document, confirm a fact).
5. **Reuse label**: "same as approved on <date>" from M2-06 where applicable.
6. **Held payment context**: the linked payment, its transfer-derived status and the "HELD FOR INFORMATION" flag; expiry countdown; the orphan-link action for unmatched RFIs.
7. **Polling**: every 3 s while the RFI is DRAFTING, ANSWER_SUBMITTING or ACTION_REQUIRED (paused when the tab is hidden, backs off on errors), announcing changes through a polite live region.
8. **States**: loading (skeleton), empty (no RFIs), error (with retry), **expired** ("expired, ask Airwallex", approve removed), answered (read-only with submitted answers), drafting-in-progress, and kill-switch-disabled banner.
9. **Accessibility**: WCAG 2.2 AA; full keyboard flow (questions list roving focus, snippet disclosure, Approve confirm dialog with focus trap and return focus), visible focus, target size, colour not the only signal, reduced motion; all text from `apps/web/src/strings.ts`.
10. **Performance**: LCP below 2.5 s, INP below 200 ms, CLS below 0.1 on the fixture RFI.

## Out of scope

- Plan screens, follow-up round UI (M3-04, M3-05), judge replay mode (M4-05)
- Any server logic beyond calling existing endpoints (gaps are filed as findings against M2-04..07)

## Acceptance Criteria

- [ ] Playwright (fixture-backed server) renders a DRAFT_READY RFI with two questions: both drafts, citations and the verbatim snippet with page next to each claim are visible
- [ ] A NEEDS_OWNER fixture shows the blocking question and reason, Approve is disabled and says why; a model-unavailable fixture shows the matching explanation
- [ ] Editing text to include a wrong figure shows the verifier rejection and keeps Approve disabled; a corrected edit creates a new draft and enables Approve
- [ ] Approve sends the approval for exactly the displayed snapshot (the request body's hash inputs equal the rendered data); a changed RFI between render and approve shows the stale error and re-renders
- [ ] Expired, answered, loading, empty, error states each have a Playwright screenshot assertion (saved under `$TMPDIR` in the gate, committed baselines only where design requires)
- [ ] 3 s polling picks up a state change from DRAFTING to DRAFT_READY without reload and announces it; polling pauses when the tab is hidden
- [ ] Keyboard-only run completes select question, expand snippet, approve; axe reports no serious or critical violations on all states
- [ ] Lighthouse CI reports LCP < 2.5 s, CLS < 0.1 and the INP proxy (TBT) within budget on the fixture
- [ ] The ui-reviewer design review passes (findings and verdict on the PR) and the screen matches `docs/design/`

## Deliverables

- `apps/web/src/app/(app)/rfis/page.tsx`, `rfis/[id]/page.tsx`, components under `apps/web/src/components/rfi/`
- Strings in `apps/web/src/strings.ts`
- `apps/web/e2e/hold-screen.spec.ts`, fixtures under `apps/web/e2e/fixtures/`

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; T="$(mktemp -d "$TMPDIR/m2-08.XXXXXX")"
npm run typecheck
npm run test -w apps/web -- rfi-ui
npm run build -w apps/web
npx playwright test apps/web/e2e/hold-screen.spec.ts --reporter=json --output "$T/pw" > "$T/pw.json"
jq -e '.stats.unexpected == 0' "$T/pw.json"
npx playwright test apps/web/e2e/hold-screen.spec.ts -g "a11y" --reporter=line
npm run lighthouse -w apps/web -- --url-path /rfis/fixture-draft-ready --assert
./scripts/check-no-secrets.sh
```

## Handoff → M2-09, M3-05, M4-05, M4-07

M2-09 drives this screen in the deployed run and takes the screenshots; M3-05 adds the follow-up reuse interaction; M4-05 serves it in replay mode; M4-07 audits accessibility and vitals. Post an issue comment with the route paths, state list, the ui-reviewer verdict and the Lighthouse numbers.
