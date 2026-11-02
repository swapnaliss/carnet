---
title: "M3-03 · Policy, auto-FX caps/slippage/AutoApproval, conversion + payout executors with attempts"
milestone: "M3 · Hold-Aware Planning"
labels: ["backend", "security"]
blocked_by: ["M3-02", "M2-07"]
estimate: "8h"
resources: ["AIRWALLEX_SANDBOX"]
needs: ["P-03"]
---

## Context

A plan that cannot execute is advice. This ticket turns plan actions into money movement under the autonomy rules of ADR 0011: RFI answers and payouts always need a person; an FX conversion may auto-execute only inside a recorded policy. It applies ADR 0007 (persisted attempt before the call, UNKNOWN resolved by lookup, no new `request_id` for the same intent) and ADR 0008 (single-use approvals bound to exact content). Rubric: R3 (moves money or state, approvals stated), R6 (typed tools, bound approvals), R5 (code enforces limits). Risks: timeouts or crashes around money calls (double payment) and held funds not visible in balances (executor re-reads balances).

## Scope

1. **Policy** (`packages/domain/src/policy/`, pure): a versioned `Policy` object (reserve floor per currency, per-action conversion limit, cumulative daily cap per currency, slippage bound in basis points against the approved indicative rate, quote freshness window) with a canonical-JSON SHA-256 `hash`. `packages/db/src/schema/policies.ts` (hot file): `policies` (business_id, version, hash, content, created_at; append-only, a change is a new version) and `auto_approvals` (id, action_id, policy_version, policy_hash, amount, currency, daily_total_after, created_at). `evaluateAutoApproval(action, state, policy)` returns `ALLOW` or `DENY(reason)` with these checks, all required: conversion kind only; post-conversion balances stay at or above the reserve floor in every currency; amount at most the per-action limit; today's cumulative auto-approved total plus this amount at most the daily cap (day boundary in the business time zone, UTC stored); the fresh quote's rate within the slippage bound of the approved indicative rate; the sell amount includes the flat SWIFT fee from the config used by the planner (not a constant).
2. **Conversion executor** (`packages/db`/worker, calls `packages/airwallex`): on a plan action in PROPOSED with an `ALLOW` result: check `execution_enabled` (the `EXECUTION_ENABLED` setting; kill switch) first; re-read balances; request a **fresh single-use FX quote** (no `x-api-version` header on FX calls); re-evaluate the policy with the fresh quote; in one transaction write the `AutoApproval` (policy version and hash), move the action to AUTO_APPROVED, and insert the `ExecutionAttempt` (INTENT) with its `request_id`; then call Airwallex; on success CONFIRMED and the action DONE; on timeout or 5xx the attempt becomes UNKNOWN and the reconciler (M1-05 skeleton, extended here with conversion lookup by `request_id`) resolves it by lookup. A conversion outside policy becomes a PROPOSED action that needs a bound approval (kind conversion: currency pair, amount, rate bounds) and is executed through the same executor after consumption.
3. **Payout executor**: a payout action is never auto-approved. The approval hash (ADR 0008) covers business, approver, nonce, source account and currency, beneficiary account fingerprint, amount, currency, fee option, value date, reference and counterparty. Execution: check `execution_enabled`; atomically consume the approval and insert the attempt in one transaction (reuse the M2-07 consume primitive); re-read balance and the beneficiary, **re-derive the hash** and refuse on mismatch; create the transfer (`transfer_method` SWIFT where the plan said so) with the attempt's `request_id`; UNKNOWN is resolved by lookup, never by a new id.
4. **Kill switch**: `execution_enabled` is checked before every executor call (conversion and payout) and again after the attempt is written but before the outbound call; when off, no new attempt is created and pending approvals stay unusable; in-flight attempts continue to resolution (the M4-02 ticket extends the controls, this ticket only provides the check).
5. **Partial plan execution and crash recovery**: a plan with several actions is executed action by action, each with its own attempt; after a crash, restart picks up actions by status (EXECUTING with an attempt means resolve the attempt, not re-send); the executor never starts action N+1 whose precondition depends on an unresolved UNKNOWN attempt.
6. **Revision interaction**: when a new plan revision arrives, actions of the previous revision that are not yet APPROVED/EXECUTING are superseded; an approval bound to content that no longer matches the current revision cannot be consumed.
7. **Tests** (integration against Docker Postgres with the Airwallex client replaying recorded responses from `fixtures/airwallex/`): ten conversions each just under the per-action limit auto-execute until the daily cap, the next is denied with reason `DAILY_CAP`; quote reuse (a second execution with an already-used quote id is refused and a fresh quote is requested); duplicate `request_id` (a second call for the same attempt reuses the id and does not create a second conversion); timeout leaves the attempt UNKNOWN and the reconciler resolves it as CONFIRMED when lookup finds it and as REJECTED/retry-same-id when it does not; a kill-switch-off run creates no attempt; slippage beyond the bound denies; floor breach denies; payout hash mismatch refused; approval consumed twice refused; crash between plan actions recovers without a double call.
8. **Live proof** (exclusive `AIRWALLEX_SANDBOX`, sandbox keys only): one real FX conversion auto-executed under policy and one real payout executed after a real bound approval; record the responses as new fixtures under `fixtures/airwallex/m3/` and the evidence in `docs/evidence/m3-03-live.md` (ids, statuses, policy version and hash, attempt rows; no secrets).

## Out of scope

- The full kill-switch/circuit-breaker governance (M4-02), the audit hash chain (M4-01), the plan and approval screens (M3-04).
- Contacting payees; sending any money from an approval the owner did not give; production keys.
- Changing the planner (M3-02) or the approval primitive (M2-07) beyond adding the conversion and payout kinds.

## Acceptance Criteria

- [ ] Policy version and hash: editing a policy inserts a new version with a different hash; the old row is unchanged; an `auto_approvals` row always references an existing version and hash (FK plus test).
- [ ] Ten conversions of 1 minor unit under the per-action limit execute and the eleventh that would push the day total over the cap is denied with `DAILY_CAP` (test uses a configured cap; the sum of ten under-limit conversions reaches the cap).
- [ ] A conversion that would breach the reserve floor, exceed the per-action limit, or fall outside the slippage bound is not auto-executed and becomes a PROPOSED action needing an approval.
- [ ] A fresh quote is requested at execution; reusing a consumed quote id is refused; FX requests carry no `x-api-version` header (asserted on the recorded request).
- [ ] The conversion amount includes the SWIFT fee read from config (change the config in the test and the amount changes).
- [ ] An `ExecutionAttempt` row exists with `request_id` before the outbound call (test makes the client throw and asserts the row); a timeout gives UNKNOWN; resolution uses lookup and no new `request_id` is minted for the same intent.
- [ ] A payout executes only after an approval whose hash covers every field in ADR 0008; changing any one field (source account, beneficiary fingerprint, amount, currency, fee option, value date, reference, counterparty) makes the executor refuse (one test per field).
- [ ] With `EXECUTION_ENABLED=false` neither executor writes an attempt or calls Airwallex.
- [ ] A simulated crash after action 1 of 3 resumes with action 2 and never re-sends action 1.
- [ ] Live: one real conversion with an `auto_approvals` row, and one real payout with a consumed approval and a CONFIRMED attempt, evidenced in `docs/evidence/m3-03-live.md` with the sandbox ids; fixtures recorded.

## Deliverables

- `packages/domain/src/policy/`, `packages/db/src/schema/policies.ts`, migrations, repositories
- `packages/airwallex/src/` FX quote/conversion lookup additions if missing from M1-03 (with contract tests on fixtures)
- Executors and reconciler additions (worker handlers), approval kinds `conversion` and `payout`
- `fixtures/airwallex/m3/`, `docs/evidence/m3-03-live.md`

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; OUT="$(mktemp -d "$TMPDIR/m3-03.XXXXXX")"
npx vitest run packages/domain/src/policy 2>&1 | tee "$OUT/policy.log"
TEST_DATABASE_URL="${TEST_DATABASE_URL:?set a throwaway database}" \
  npx vitest run packages/db/src/executors packages/db/src/policies 2>&1 | tee "$OUT/exec.log"
grep -E 'DAILY_CAP|quote reuse|UNKNOWN|kill switch' "$OUT/exec.log" >/dev/null
# live proof (sandbox keys from .env; exclusive AIRWALLEX_SANDBOX)
M3_LIVE=1 npx vitest run packages/db/src/executors/live.test.ts
test -s docs/evidence/m3-03-live.md
! grep -rEn 'AIRWALLEX_API_KEY=[^ ]' docs/evidence fixtures
./scripts/landing-checks.sh --fast
```

## Handoff

- **M3-04** shows each action's approval state (PROPOSED, APPROVED, AUTO_APPROVED with policy version and hash, DONE, FAILED) and issues payout/conversion approvals bound to the content it displays.
- **M3-07** runs the executors live against the deployed product.
- **M4-02** extends the kill switch, **M4-01** chains audit rows for AutoApproval and attempts, **M4-03** evals reuse these denials.
Post as an issue comment: the policy fields and default values for the demo, the approval hash field list as implemented, the sandbox conversion and transfer ids from the live proof, fixtures recorded, and anything the sandbox did differently from `docs/evidence/airwallex-rfi-contract.md` (mark unverified items as such).
