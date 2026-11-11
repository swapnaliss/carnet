# ADR 0020: Plan action state and single-use FX quotes

Status: accepted (11 Nov 2026), applies ADR 0007, 0008 and 0011 (M3-03)

## Context
Plan revisions are append-only: the app role cannot UPDATE `plans` or `plan_actions` (M3-02). Executing a plan needs a mutable per-action life (proposed, approved, executing, done, failed, superseded). Airwallex returns FX quotes as `MULTI_USE` and accepted a reused quote in the sandbox (M0-03), so single use cannot rely on the provider. A conversion create that times out has an unknown outcome, and absence from a list is not proof of absence (BL-01).

## Decision
1. **Action state lives in `plan_action_states`**, one row per action, moved only by compare-and-set updates (`PROPOSED` is also "no row"). A new revision supersedes earlier actions that are not yet APPROVED or EXECUTING and ends their conversion approvals; an APPROVED action of an older revision is executable only while the newest revision still contains an action of the same kind with identical parameters.
2. **Quotes are single use in Carnet**: `fx_quote_uses(quote_id primary key)` is claimed in the same transaction as the attempt. A claimed id is refused and a fresh quote is requested (twice, then the action stays PROPOSED).
3. **The auto-approval and the attempt are one transaction.** `auto_approvals` (policy version and hash by composite foreign key to `policies`), the action state, the quote claim and the `ExecutionAttempt` INTENT commit together; the daily cap is re-read under an advisory lock in that transaction. Policies, auto-approvals and quote uses are append-only.
4. **A conversion UNKNOWN attempt is looked up by `request_id`** (`GET /fx/conversions?request_id=`, filter unverified, so also filtered client-side). Found: CONFIRMED. Not found: stays UNKNOWN until a wait (default five minutes) has passed, then the SAME `request_id` is sent again; a definite 4xx ends it REJECTED. A new `request_id` is never minted for the same intent. Whether Airwallex de-duplicates a repeated conversion `request_id` is unverified.
5. **A payout approval is bound to payment-level fee option and value date**, stored on `payments` (`fee_option`, `value_date`) because the payment row is what the transfer is created from. The value date is bound but not sent: the adapter has no field for it (unverified in the sandbox).

## Alternatives considered
Mutable `plan_actions` (breaks the append-only guarantee the plan history relies on); relying on the provider to refuse a reused quote (the sandbox does not); a new request id after a lookup miss (risks a double conversion).

## Consequences
Cost to reverse: moderate (two tables, one column pair). M3-04 reads `plan_action_states` and `auto_approvals` for the plan screen; M4-01 chains the audit rows these executors append.
