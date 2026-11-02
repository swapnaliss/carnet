---
title: "M2-06 · Answer memory (normalised fingerprint reuse)"
milestone: "M2 · Evidence to Answer"
labels: ["backend"]
blocked_by: ["M2-05"]
estimate: "4h"
resources: []
needs: []
---

## Context

Pain evidence in PROJECT.md §2: "six different agents… Each one asked for the same documents again, just worded differently". The follow-up round in the storyboard (2:25) reuses an approved answer in one click. Reuse must never be a guess: the architecture allows reuse only on a deterministic, normalised **exact** fingerprint (counterparty plus question text); there is no vector search (architecture §13). A reused answer is still re-verified and still needs a new bound approval (R6); memory saves typing, it does not bypass approval.

## Scope

1. **Fingerprint function** (pure, `packages/domain`): `fingerprint(counterpartyId, questionText)` = SHA-256 over the counterparty id and the question text after deterministic normalisation (Unicode NFKC, lower case, trim, collapse whitespace, strip punctuation, no stemming, no synonym handling). Includes the question's `answer_type`. The normalisation is versioned (`fp_version`) so a future change cannot silently match old rows.
2. **`answer_memory`** per architecture §5 (business_id, counterparty_id, fingerprint, fp_version, answer_text, citations, source_approval_id, approved_at, attachment document ids and sha256) with the index `(business_id, counterparty_id, fingerprint)`. A row is written **only** when an approval is consumed and the respond attempt is CONFIRMED or the RFI is ANSWERED (hook consumed from M2-07's `answer.submitted` event); never from a draft or a rejected approval. Rows are immutable; newer approvals add rows and the lookup returns the latest.
3. **Lookup**: `findReusable(business, counterparty, questionText, answerType)` returns the most recent approved answer for an identical fingerprint, else nothing. Any difference in the normalised text (a changed number, an added clause, a different counterparty) yields no match.
4. **Surfacing**: the M2-05 draft input receives matches as optional `prior_approved` data; the draft output marks a question `reused_from` when the model text is identical to the memory text, and the **reuse path in code** can instead pre-fill the answer directly from memory without any model call (one-click reuse). Either way the result runs through the M2-05 verifier against the **current** facts: a reused answer whose cited facts are no longer valid (a newer fact version contradicts, document missing) becomes `NEEDS_OWNER` with reason `REUSE_STALE`.
5. **Provenance label**: API exposes `{reused: true, approved_on: <date>, source_approval_id}` so the UI can show "same as approved on <date>".
6. **Scope isolation**: never across businesses, never across counterparties.
7. Audit entry on each reuse.

## Out of scope

- Fuzzy or semantic matching (rejected alternative; trigger recorded: answer memory beyond 10,000 entries)
- The follow-up round UI (M3-05)
- Approval (M2-07)

## Acceptance Criteria

- [ ] Identical question text with different case, spacing and punctuation produces the same fingerprint; a text with a changed digit, word or counterparty produces a different one (table + property tests)
- [ ] After an approved, ANSWERED fixture RFI, a follow-up round with the same question text for the same counterparty returns the stored answer with its citations; with one word changed returns nothing
- [ ] Nothing is written to memory for drafts, rejected, expired or not-yet-confirmed approvals (test)
- [ ] A reused answer whose cited fact version was superseded by a conflicting newer version is `NEEDS_OWNER` (`REUSE_STALE`), not silently reused
- [ ] Cross-business and cross-counterparty lookups return nothing
- [ ] The API response carries the approved date and source approval id; reuse writes an audit entry
- [ ] Reuse path makes zero model calls (transport spy)

## Deliverables

- `packages/domain/src/rfi/fingerprint.ts` and tests
- `packages/db/src/schema/answer-memory.ts`, migration, repository
- `packages/agent/src/drafting/reuse.ts`, event handler for `answer.submitted`
- `apps/web/src/app/api/v1/rfis/[id]/reuse/route.ts`

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; T="$(mktemp -d "$TMPDIR/m2-06.XXXXXX")"
npm run typecheck
npm run test -w packages/domain -- fingerprint
npm run test -w packages/db -- answer-memory
npm run test -w packages/agent -- reuse --reporter=json --outputFile="$T/reuse.json"
test "$(jq '[.testResults[].assertionResults[] | select(.status=="failed")] | length' "$T/reuse.json")" = 0
./scripts/check-no-secrets.sh
```

## Handoff → M2-08, M2-09, M3-05

M2-08 shows "same as approved on <date>"; M3-05 builds the follow-up round on `findReusable`; M2-09 may exercise reuse only if the sandbox follow-up is available. Post an issue comment with the fingerprint version, the API shape and the stale-reuse reason code.
