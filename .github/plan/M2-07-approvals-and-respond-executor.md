---
title: "M2-07 · Approvals (binding hash, atomic consume), ExecutionAttempt, respond executor with UNKNOWN resolution"
milestone: "M2 · Evidence to Answer"
labels: ["backend", "security", "agent"]
blocked_by: ["M2-04", "M1-03"]
estimate: "8h"
resources: []
needs: []
---

## Context

R3 and R6: the product submits to a regulated review only what a person approved, bound to the exact content shown. ADR 0008 defines the hash and the atomic single-use consume; ADR 0007 requires a persisted `ExecutionAttempt` before any respond call and resolution of unknown outcomes by lookup, never by a new `request_id`; ADR 0009 keeps the model away from execution (the executor takes an approval and nothing the model produced directly). RFI answers always need a person (architecture §10). Blast radius is a false statement sent to a risk review, so this is the most security-sensitive code in M2. Proof uses the M0-04 recorded respond, timeout and RFI fixtures; no live calls.

## Scope

1. **Canonical JSON and hash** (pure, `packages/domain/src/approvals/`): deterministic serialisation (sorted keys, no insignificant whitespace, strings NFC, integers only) and SHA-256 over: `business_id`, `approver_id`, `nonce`, `kind: "rfi_answer"`, `rfi_id`, RFI `updated_at`, per question `{id, text}`, per answer text, attachment document ids and their sha256, the evidence fact version ids shown, draft id, prompt version. The draft/fact inputs are a typed `ApprovalSubject` interface; tests use fixture drafts, and the real draft rows from M2-05 are plugged in by M2-08/M2-09 through the same interface (payout and conversion variants are added in M3-03). Any single changed byte in any field changes the hash (property test over every field).
2. **`approvals` table** (architecture §5: id, business_id, kind, subject_ref, hash, nonce, approver_id, status `PENDING → APPROVED | REJECTED | EXPIRED → CONSUMED`, expires_at, consumed_at, shown_snapshot) with migration and repository. `shown_snapshot` stores exactly what the approver saw.
3. **Approve endpoint** `POST /api/v1/rfis/{id}/approvals` (idempotency key per ADR 0004; role owner or approver only, server-side; nonce is server generated): builds the subject from current RFI, current draft and fact versions, stores the hash and snapshot, status `APPROVED`. Refuses if the RFI is not `DRAFT_READY`, any answer is `NEEDS_OWNER`, or the draft is not the latest. **TTL** = `APPROVAL_TTL_MINUTES` (default 30) capped at `rfi.expires_at` minus a 5-minute margin; if that is not positive the approval is refused ("too close to expiry"). Rejection and edit paths mark the approval `REJECTED`/superseded. Moves the RFI to `APPROVED` through the M2-04 machine.
4. **Atomic consume + attempt**: one DB transaction runs `UPDATE approvals SET status='CONSUMED', consumed_at=now() WHERE id=? AND status='APPROVED' AND hash=? AND expires_at > now() RETURNING *` and inserts the `execution_attempts` row (`kind: respond`, `ref_id` = RFI id, `request_id` generated once, status `INTENT`), and moves the RFI to `ANSWER_SUBMITTING`. Zero rows returned means refuse; nothing is sent. A second concurrent consumer gets zero rows.
5. **Respond executor** (worker job `rfi.respond`, not in a web request): after consuming, (a) re-read the RFI via the M1-03 adapter; refuse if its `updated_at`, status or question set differ from the approved subject, or it is no longer `ACTION_REQUIRED`; (b) re-derive the hash from current state and compare to the approved hash; (c) load each attachment's bytes and re-hash, compare to the approved sha256; (d) upload PDF/JPEG attachments to the files host (filename at most 50 characters, M0-04 limits), collect `file_id`s; (e) build the respond body answering **all** questions (TEXT with comment, ATTACHMENT with file ids); (f) mark attempt `SENT_TO_AIRWALLEX` and `POST /rfis/{id}/respond` with the attempt's `request_id` and a 10 s timeout; (g) on success mark `CONFIRMED`, RFI `ANSWERED`, publish `answer.submitted`; on a 4xx rejection mark `REJECTED` with the provider error, RFI back to `NEEDS_OWNER` with the reason; on a respond that finds the RFI `CLOSED`, RFI `EXPIRED` (M2-04), payment unchanged.
6. **Unknown outcomes**: timeout or 5xx marks the attempt `UNKNOWN` and **keeps the request_id**; the reconcile job (M1-05 skeleton extended here) resolves each UNKNOWN respond attempt by `GET /rfis/{id}`: `ANSWERED` means the attempt is `CONFIRMED` (treated as done, no second respond); `ACTION_REQUIRED` with unchanged questions allows a retry of the same intent with the same `request_id` within the approval's validity, else `NEEDS_OWNER` with a new approval required; `CLOSED` means `EXPIRED`. No path mints a new request_id for the same intent. Executor entry on an RFI already `ANSWERED` is a no-op success.
7. **Kill switch**: `execution_enabled=false` before consume makes consume refuse and invalidates pending approvals (status `EXPIRED`, reason `KILL_SWITCH`); an attempt already past `INTENT` continues to resolution (ADR/architecture §10).
8. **Audit entries** for approval granted/rejected/expired/consumed, attempt transitions, uploads (file id, sha256), respond result, refusal reasons; never answer text bytes beyond the hash plus snapshot reference.
9. **No model in the path**: the executor module imports nothing from `packages/agent` (lint-enforced boundary test).

## Out of scope

- Payout and conversion approvals and executors (M3-03), auto-approval policies (ADR 0011)
- The hold screen (M2-08) and live proof (M2-09)
- Audit hash chain internals (M4-01; this ticket calls the audit port)

## Acceptance Criteria

- [ ] Hash tests: identical subject gives identical hash across runs and key order; changing each of business, approver, nonce, rfi id, RFI `updated_at`, a question id/text, an answer text (one character), an attachment id/sha256, a fact version id, the draft id and the prompt version changes the hash (one test per field)
- [ ] Replay: consuming the same approval twice (sequential and 20 concurrent tries) results in exactly one `CONSUMED` row, one attempt and one respond call on the fixture transport
- [ ] TOCTOU: after approval, change the RFI (fixture with newer `updated_at`, an added question, a status change to CLOSED) and the executor refuses without calling respond; the attempt shows the refusal reason
- [ ] Tamper: altering stored attachment bytes after approval makes the executor refuse (re-hash mismatch); altering an answer text after approval makes the consume WHERE or the re-derived hash refuse
- [ ] Approval cannot be created for `NEEDS_OWNER` RFIs, for stale drafts or by a `viewer`; TTL never exceeds `expires_at` minus the margin; an expired approval cannot be consumed
- [ ] Kill switch: with `execution_enabled=false` nothing is consumed or sent and pending approvals read `EXPIRED`; an in-flight `SENT_TO_AIRWALLEX` attempt still resolves
- [ ] Timeout fixture: attempt becomes `UNKNOWN` with the original `request_id`; reconciler with the recorded `ANSWERED` RFI sets `CONFIRMED` and sends no second respond; with `ACTION_REQUIRED` the retry reuses the same `request_id`; with `CLOSED` the RFI is `EXPIRED`
- [ ] Respond body answers all questions and uses file ids from the recorded upload fixture; a fixture 4xx moves the RFI to `NEEDS_OWNER` with the provider reason
- [ ] The consume and attempt insert happen in one transaction (test forces a failure after consume and sees the approval still `APPROVED`)
- [ ] Executor package imports no model code (boundary test); every step writes an audit entry; no entry contains secrets
- [ ] Cross-tenant approval ids are `404`

## Deliverables

- `packages/domain/src/approvals/` (`canonical.ts`, `hash.ts`, `subject.ts`) and tests
- `packages/db/src/schema/approvals.ts`, `execution-attempts.ts`, migrations, repositories (`consumeApproval` + attempt insert in one function)
- `apps/web/src/app/api/v1/rfis/[id]/approvals/route.ts`, `.../approvals/[approvalId]/reject/route.ts`
- `apps/web/src/worker/handlers/rfi-respond.ts`, reconcile extension, `packages/airwallex` usage only through the M1-03 adapter
- `docs/adr/` addendum only if a gap in ADR 0008 is found (file a new ADR before code depending on it)

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; T="$(mktemp -d "$TMPDIR/m2-07.XXXXXX")"
npm run typecheck
npm run test -w packages/domain -- approvals
npm run test -w packages/db -- approvals execution-attempts
npm run test -w apps/web -- rfi-respond --reporter=json --outputFile="$T/respond.json"
test "$(jq '[.testResults[].assertionResults[] | select(.status=="failed")] | length' "$T/respond.json")" = 0
npm run test -w apps/web -- approval-replay approval-toctou approval-killswitch respond-unknown
! grep -rn "packages/agent\|@carnet/agent" apps/web/src/worker/handlers/rfi-respond.ts packages/domain/src/approvals
./scripts/check-no-secrets.sh
```

## Handoff → M2-08, M2-09, M3-03

M2-08 calls the approval endpoints with the exact snapshot it displays; M2-09 proves the flow live; M3-03 extends the subject union and the consume function for payouts and conversions. M2-06 listens for `answer.submitted`. Post an issue comment with the canonical JSON field list, the TTL rule, the attempt state table and the reconciler outcomes.
