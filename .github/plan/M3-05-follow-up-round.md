---
title: "M3-05 · Follow-up round (reopen + reuse UI)"
milestone: "M3 · Hold-Aware Planning"
labels: ["frontend", "backend"]
blocked_by: ["M2-06", "M2-08"]
estimate: "4h"
resources: []
needs: ["P-10"]
---

## Context

The owner's pain quote is "six different agents… Each one asked for the same documents again, just worded differently". After an RFI is answered, Airwallex can reopen questions (`POST /simulation/rfis/{id}/follow_up` in the sandbox, reopening answered questions by id and/or appending new ones). A follow-up round must not make the owner redo work: an unchanged question reuses the approved answer, and a changed question gets a new draft. Pillar 2 (bound-approval answers), rubric R1 and R4 (storyboard 2:25: "a follow-up reopens a question and the approved answer is reused in one click"). Reuse is only on the deterministic normalised exact fingerprint (counterparty + question text) from M2-06; it is still a **fresh bound approval** (ADR 0008), never a silent resend (ADR 0007, 0010).

## Scope

1. **Follow-up intake** (`packages/db` worker handler, extends M2-04): on `rfi.action_required` for an RFI we already hold in ANSWERED/CLOSED state, fetch the RFI, diff its questions against the stored round, and move the RFI REOPENED then DRAFTING with `round + 1`; record which question ids were reopened and which are new. Orphan/duplicate events are idempotent (same event id gives no second round). Respond-after-ANSWERED semantics follow the M0-04 fixtures; if the fixtures show behaviour different from `docs/evidence/airwallex-rfi-contract.md`, follow the fixtures and update that file's observed section.
2. **Reuse via answer memory** (uses M2-06): for each question in the new round compute the normalised fingerprint; where it matches an approved answer for the same counterparty, create a draft answer marked `reused_from` (approval id and date) instead of calling the model; the verifier still runs on it (citations exist, numbers/dates/names appear in cited facts) and a failed verification makes it NEEDS_OWNER. Where the text changed, no reuse: a new model draft is created through the M2-05 pipeline.
3. **Approval**: reused answers appear as "Same as approved on <date>" with the original answer and its citations; the owner applies them in one click; the click creates a **new** approval whose hash is computed over the content shown (RFI id and version, question ids and text, answer text, attachment ids and hashes, fact versions, draft id and prompt version); the previous approval is never reused or extended. NEEDS_OWNER on any question blocks the whole RFI and the UI says why (respond needs every question).
4. **Hold screen addition** (builds to `docs/design/`; extends the M2-08 screen): a round indicator ("Round 2"), a per-question badge (Reused / New draft / Needs you), a "Apply all reused answers" action that is a single approval over all answers shown, and a diff of old and new question text for changed questions. Strings in the strings module; loading, empty and error states; keyboard operable; no optimistic updates. Passes the `ui-reviewer` design review.
5. **Tests on fixtures from M0-04** (`fixtures/airwallex/` follow_up responses): reopen of one question unchanged (reused), reopen with changed text (new draft), appended new question (new draft), duplicate event (no second round), all-reused with verifier failure on one (NEEDS_OWNER, whole RFI blocked), approval hash differs from round 1, using the round 1 approval for round 2 is refused. Playwright test of the one-click flow against recorded data.

## Out of scope

- Creating the follow-up in the sandbox (that is the simulator call used by M3-07), the first-round drafting (M2-05), the memory store (M2-06).
- Fuzzy or semantic matching of questions (reuse is exact normalised fingerprint only).
- Contacting anyone; auto-submitting a reused answer.

## Acceptance Criteria

- [ ] A recorded follow-up event on an ANSWERED RFI creates round 2 in DRAFTING, with reopened and new question ids recorded; replaying the same event creates no second round.
- [ ] A reopened question whose normalised fingerprint matches an approved answer shows "Same as approved on <date>" and makes **zero** model calls (assert on the harness run table).
- [ ] A changed question gets a new draft from the M2-05 pipeline and is not marked reused.
- [ ] Applying reused answers creates a new approval with a different hash from round 1; submitting with the round 1 approval is refused (integration test).
- [ ] If the verifier fails a reused answer, the question is NEEDS_OWNER and the screen names the question and states that the whole RFI is blocked.
- [ ] The extended hold screen passes axe (no serious/critical), is keyboard operable, has the three states, and was built to `docs/design/` and passed `ui-reviewer`.
- [ ] The fixtures from M0-04 drive all tests; no live call is needed (live proof is in M3-07).

## Deliverables

- Follow-up handler and reuse logic in `packages/db` / `packages/agent` (worker)
- Hold-screen changes under `apps/web/src/app/rfis/`, strings additions
- Tests and `apps/web/e2e/follow-up.spec.ts`

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; OUT="$(mktemp -d "$TMPDIR/m3-05.XXXXXX")"
TEST_DATABASE_URL="${TEST_DATABASE_URL:?set a throwaway database}" \
  npx vitest run packages/db/src/rfis/follow-up packages/agent/src/reuse 2>&1 | tee "$OUT/unit.log"
npm run build -w apps/web
npx playwright test apps/web/e2e/follow-up.spec.ts --output "$OUT/pw"
grep -E 'zero model calls|round 2' "$OUT/unit.log" >/dev/null
./scripts/landing-checks.sh --fast
```

## Handoff

- **M3-07** triggers a real follow-up in the sandbox and expects round 2 with one reused answer applied in one click.
- **M4-03** adds follow-up cases to the evals; **M4-05** replays a recorded follow-up round.
Post as an issue comment: how reopened vs new questions are detected, any difference between the fixtures and the contract file (and that the contract file was updated), the fresh-approval behaviour, and the design-review verdict.
