---
title: "M2-04 · RFI ingest, RFI state machine, orphan queue, expiry"
milestone: "M2 · Evidence to Answer"
labels: ["backend"]
blocked_by: ["M1-05", "M1-03"]
estimate: "7h"
resources: []
needs: []
---

## Context

R1 (a repeated task with a real decision) starts when an Airwallex Transaction RFI arrives. The contract in `docs/evidence/airwallex-rfi-contract.md` says webhooks `rfi.action_required`, `rfi.answered` and `rfi.closed` carry only the RFI id, so handlers must fetch the RFI and its questions; events are at-least-once and unordered (ADR 0005); an RFI never changes a payment's money status (ADR 0006); Airwallex allows one open TRANSACTION RFI at a time (PROJECT.md §10). Behaviour the M0-04 spike measured (partial respond, expiry, follow-up) overrides anything below that the fixtures contradict; this ticket records any difference in the contract file.

## Scope

1. **Handlers** registered with the M1-05 worker for `rfi.action_required`, `rfi.answered`, `rfi.closed`: fetch `GET /rfis/{id}` through the M1-03 adapter, ignore the payload status, apply only if the fetched `updated_at`/status is not older than the stored one (stale events are dropped and logged).
2. **Reconcile poll**: extend the M1-05 reconcile job to `GET /rfis` (statuses `ACTION_REQUIRED`, `ANSWERED`, `CLOSED`, type `TRANSACTION`) and ingest anything missing or newer, so a missed webhook is recovered within 60 s.
3. **Tables**: `rfis` and `rfi_questions` per architecture §5 (airwallex_rfi_id unique per business, state, expires_at, payment_id nullable, airwallex_updated_at, round; question id, title, description, answer_type, sources, round), migration and repository.
4. **Matching**: a question whose `sources` contain a `TRANSFER` id that maps to a stored payment's `transfer_id` links the RFI to that payment. No sources, an unknown transfer id, a non-TRANSFER source only, or sources pointing to several payments put the RFI in the **orphan / account-level queue** (`payment_id` null, reason code stored); an owner can later link it explicitly (endpoint with audit entry). Matching is a pure function with table tests.
5. **State machine** (pure, in `packages/domain`): `ACTION_REQUIRED → DRAFTING → DRAFT_READY | NEEDS_OWNER → APPROVED → ANSWER_SUBMITTING → ANSWERED → CLOSED | REOPENED | EXPIRED`, with the transition table, guards and the event each transition emits; illegal transitions throw a typed error and are never applied silently. `REOPENED → DRAFTING` starts a new round.
6. **Expiry**: if a respond attempt (M2-07) or a fetch finds the RFI `CLOSED` while Carnet's state is not ANSWERED, state becomes `EXPIRED` and the owner sees "expired, ask Airwallex"; the payment keeps its own status from the transfer projection. A scheduled check marks RFIs past `expires_at` as expiring-soon for the UI.
7. **Follow-up**: Airwallex reopening answered questions (fetched RFI back to `ACTION_REQUIRED` with a newer `updated_at` and reopened question ids) creates a new round (`round+1`) with only the reopened and new questions flagged for drafting; earlier rounds stay immutable.
8. **One-open-RFI-per-type rule**: ingest never creates two open TRANSACTION RFIs for one business; a second open one from the provider is stored but flagged `conflict` and surfaced, not merged. A fixture-based concurrency test replays two simultaneous `rfi.action_required` deliveries (and duplicate deliveries of the same event) and asserts a single open RFI row and single DRAFTING transition.
9. **Held flag**: when an RFI is linked to a payment and open (`ACTION_REQUIRED`..`ANSWER_SUBMITTING`), the payment's `held` flag is true via the existing `project(transferStatus, openRfi)`; the handler never writes SENT, PAID or FAILED (invariant test).
10. **Draft trigger**: on entering `DRAFTING` the handler enqueues the `rfi.draft` job (consumed by M2-05) in the same transaction as the state change (outbox).
11. Audit entries for every state transition and every link/unlink.

## Out of scope

- Drafting and verification (M2-05), approval and respond (M2-07), UI (M2-08)
- Creating simulated RFIs (the M1-03 `SandboxSimulator` port is used only by tests and M2-09)

## Acceptance Criteria

- [ ] Replaying the M0-04 / M0-05 recorded RFI and webhook fixtures through the worker creates the RFI, its questions and the DRAFTING transition and enqueues exactly one `rfi.draft` job
- [ ] A fixture RFI whose question source is a known TRANSFER id links to that payment and sets `held`; unknown, absent and multiple sources land in the orphan queue with distinct reason codes
- [ ] Duplicate, stale and permuted-order deliveries (property test over event orderings) end in the same final state
- [ ] The concurrency test (parallel deliveries, two workers claiming jobs) leaves one open RFI per business and type and no duplicate jobs
- [ ] A fetched `CLOSED` RFI while in `APPROVED` or `ANSWER_SUBMITTING` becomes `EXPIRED`; the linked payment's projected money status is unchanged (test with a transfer in PROCESSING)
- [ ] Follow-up fixture: the second round reuses the RFI row, increments `round`, and round 1 questions and drafts remain unchanged
- [ ] Invariant test: no RFI event or state transition changes `transfer_status`
- [ ] A missed webhook (no event stored) is ingested by the reconcile poll from the recorded list fixture
- [ ] Every illegal transition in the table is rejected; the full transition table has a test per edge
- [ ] Cross-tenant: RFIs of another business are never matched or returned

## Deliverables

- `packages/domain/src/rfi/state-machine.ts`, `matching.ts` and tests
- `packages/db/src/schema/rfis.ts`, migration, repository
- `apps/worker` or `apps/web/src/worker/handlers/rfi.ts` (per M1-05 layout), reconcile extension
- `apps/web/src/app/api/v1/rfis/` read routes and the orphan-link endpoint
- Updates to `docs/evidence/airwallex-rfi-contract.md` only where fixtures contradict it

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; T="$(mktemp -d "$TMPDIR/m2-04.XXXXXX")"
npm run typecheck
npm run test -w packages/domain -- rfi
npm run test -w packages/db -- rfis
npm run test -w apps/web -- rfi-ingest --reporter=json --outputFile="$T/ingest.json"
test "$(jq '[.testResults[].assertionResults[] | select(.status=="failed")] | length' "$T/ingest.json")" = 0
npm run test -w apps/web -- rfi-concurrency
npm run test -w apps/web -- rfi-invariant-no-money-status
./scripts/check-no-secrets.sh
```

## Handoff → M2-05, M2-07, M2-08, M3-05

M2-05 consumes the `rfi.draft` job and `rfi_questions`; M2-07 transitions APPROVED, ANSWER_SUBMITTING, ANSWERED and EXPIRED through the state machine; M2-08 lists RFIs, the orphan queue and states. Post an issue comment with the transition table, job names, orphan reason codes and any contract differences found against fixtures.
