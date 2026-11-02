---
title: "M2-03 · Evidence rules, strength flags, payment pre-send check, queue UI"
milestone: "M2 · Evidence to Answer"
labels: ["frontend", "backend"]
blocked_by: ["M2-02", "M1-07"]
estimate: "7h"
resources: []
needs: []
---

## Context

Pillar 1 (evidence-first payments) and R1: before a payment moves, the owner sees whether the documents on file would survive a review, so the evidence is already in place when an RFI arrives. The judgement is made by **code** (R5), never the model: the rules read verified or owner-confirmed facts from M2-02 and produce a Strong, Weak or Missing flag with reasons. The storyboard at 0:25 shows evidence flags with one weak payment.

## Scope

1. **Pure rules in `packages/domain`** (no I/O, table-driven tests): input = payment (amount minor, currency, payee/counterparty name, reference), linked documents' usable facts (verified quote or owner-confirmed only), counterparty history (prior payments count), policy (`contract_required_above_minor` per currency, stored in the business policy). Rules:
   - R-AMT: an invoice fact total equals the payment amount and currency exactly (integer minor units)
   - R-PAYEE: payee name matches the invoice supplier name after deterministic normalisation (case, punctuation, legal-suffix list); near matches are reported as `mismatch` with both values, never auto-accepted
   - R-CONTRACT: for the first payment to a counterparty with amount above the policy threshold, a contract naming that counterparty is present
   - R-VERIFIED: every fact used is quote-verified or owner-confirmed; unverified facts count as absent
   - Each rule returns `{rule, outcome: pass|fail|missing, reasons[], fact_version_ids[]}`.
2. **Strength flag**: `Strong` = all applicable rules pass; `Weak` = at least one applicable rule fails or a fact is unverified; `Missing` = no invoice (or a required contract) linked at all. The flag carries ordered reasons in plain language from the strings module. Same inputs always give the same flag (determinism test).
3. **Pre-send check**: `GET /api/v1/payments/{id}/evidence-check` and a server-side guard the create-payment flow calls; a Weak or Missing payment can still be sent but only after an explicit acknowledgement recorded in the audit log (`evidence_override`, user, reasons shown); nothing is blocked silently and nothing is sent without the check having run.
4. **Evidence links**: `evidence_links` rows (payment_id, document_id, fact_version_id) created when the owner attaches documents to a payment; the check recomputes on every change and stores the flag snapshot with the fact version ids it used.
5. **Screens** (Next.js App Router, built to `docs/design/` from M1-07): payment queue (list with flag chips, filters by flag, status from the transfer projection), evidence view (documents attached, each rule with pass/fail/missing, the quote snippet and page beside each fact, upload via M2-01, confirm facts for image-only documents, acknowledge-and-send). Loading, empty and error states, keyboard flow, WCAG 2.2 AA, all text from the strings module.
6. **Design review**: this is a `frontend` ticket; it passes the independent `ui-reviewer` design review and builds to `docs/design/` (M1-07).

## Out of scope

- Creating beneficiaries or the transfer itself (M1-08 already creates payments; this ticket adds the check in front)
- The RFI hold screen (M2-08), criticality, plan screens (M3)
- Model calls (none here)

## Acceptance Criteria

- [ ] Table-driven tests cover every rule with pass, fail and missing cases, including currency mismatch, off-by-one minor unit, supplier near-match, first-payment contract rule at the threshold boundary (equal, +1)
- [ ] Facts that are unverified (quote not found) or image-only and unconfirmed never contribute to a pass (test)
- [ ] Property test: the flag is deterministic and monotone (adding a passing, verified document never worsens the flag)
- [ ] For the `fixtures/dataset/` scenarios the flags match the dataset's expected flags (at least one Strong, one Weak, one Missing)
- [ ] Sending a Weak or Missing payment without acknowledgement is rejected by the server; with acknowledgement the audit log has an `evidence_override` entry holding the reasons shown
- [ ] Queue and evidence view render loading, empty and error states; the evidence view shows the source quote and page beside each fact; a keyboard-only run (Playwright) uploads, confirms a fact and reaches the acknowledge-and-send action
- [ ] axe reports no serious or critical violations on both screens
- [ ] The ui-reviewer design review passes and its findings are recorded on the PR
- [ ] Cross-tenant requests for another business's payment evidence return `404`

## Deliverables

- `packages/domain/src/evidence/rules.ts`, `strength.ts` and tests
- `packages/db` `evidence_links` schema, migration, repository
- `apps/web/src/app/api/v1/payments/[id]/evidence-check/route.ts`, evidence link routes
- `apps/web/src/app/(app)/payments/page.tsx`, `payments/[id]/evidence/page.tsx`, components, strings in `apps/web/src/strings.ts`
- `apps/web/e2e/evidence.spec.ts`

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; T="$(mktemp -d "$TMPDIR/m2-03.XXXXXX")"
npm run typecheck
npm run test -w packages/domain -- evidence
npm run test -w packages/db -- evidence-links
npm run test -w apps/web -- evidence-check
npx playwright test apps/web/e2e/evidence.spec.ts --reporter=json > "$T/pw.json"
jq -e '.stats.unexpected == 0' "$T/pw.json"
npm run build -w apps/web
./scripts/check-no-secrets.sh
```

## Handoff → M2-09

M2-09 runs the evidence flags step of the storyboard through these screens and the pre-send guard. Post an issue comment with the rule ids, the flag reasons keys, route paths and the ui-reviewer verdict.
