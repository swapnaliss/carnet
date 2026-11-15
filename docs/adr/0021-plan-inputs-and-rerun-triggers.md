# ADR 0021: Plan inputs in production and the re-run triggers

Status: accepted (14 Nov 2026), applies ADR 0005, 0006 and 0009 (M3-02, BL-01 found in M3-07)

## Context
M3-02 built the pure planner and a `plan.rerun` handler, but the deployed worker started without a loader of the planner's inputs, so the handler was never registered, and nothing outside tests enqueued it. The running product never wrote plan revision 1 or 2. This ADR records how the inputs are read and what asks for a re-run; it adds no service, store or queue.

## Decision
1. **One production loader** (`apps/web/src/worker/plan-inputs.ts`) builds `PlanInputsInput` per business: obligations (owner-confirmed criticality or `UNCONFIRMED`, never a proposal), held payments, balances and indicative rates from Airwallex through the existing client and its timeouts, the reserve floor and auto-convert limits from the newest policy version, fees and spread from `config/fees.json`. Both worker entrypoints start the worker with `planInputs: "production"`.
2. **A payment is held when its transfer is in flight and a holding RFI links to it.** The RFI only sets the flag; money status still comes from the transfer (ADR 0006), and the loader never writes a payment.
3. **An obligation leaves the plan once its money is on its way**: its payment's transfer is SCHEDULED, PROCESSING, SENT or PAID and not held (Airwallex debits the balance at creation, M0-04 check 8, so the balance already shows it). FAILED, CANCELLED and not-yet-sent payments leave it owed. A held payment keeps its obligation in, because the alternate payout is for it.
4. **Airwallex is read before the re-run's transaction opens** (`PlanInputsLoader.prefetch`), because the pool ends a session idle in a transaction after 30 s and a read with retries can outlast it. The database reads stay inside the transaction under the per-business advisory lock.
5. **Indicative rate**: `GET /fx/rates/current` for each (sell currency held, buy currency owed) pair, CLIENT level, `buy_amount / sell_amount` for 100 major units, rounded down to four places; `as_of` is the start of the UTC day of the answer so that it does not change `inputs_hash` on every call. A 4xx for a pair omits it (the plan cannot convert it); a timeout or 5xx fails the job, which retries with backoff.
6. **Triggers enqueue `plan.rerun` in the transaction that changes the input** (`enqueuePlanRerun`, `packages/db`): obligation created, criticality confirmed, payment submitted, a transfer status applied, an RFI entering or leaving a holding state or changing its payment, a new policy version. A revision is written only when `inputs_hash` changed, so asking too often is harmless.
7. An obligation without a payment is planned as SWIFT (the case that costs the flat fee), so the plan does not under-fund it; a payment's own `method` wins when it has one.

## Alternatives considered
Polling balances on a timer (a new loop, and the plan would lag a change by up to a period); reading Airwallex inside the transaction (idle-in-transaction timeout); a separate planning service (no requirement needs one).

## Consequences
Cost to reverse: low. Unverified: the rate's behaviour outside the sandbox, a held cross-currency transfer's source amount (stored amount is the transfer amount), and a balance change from an executed conversion, which has no trigger of its own and is picked up by the next event.

## Amendment 1 (15 Nov 2026): which currency a shortfall is converted from
Owner decision on issue #40 (found in the M3-07 live run, BL-01). The loader reads a rate for every currency with a positive balance, and the sandbox holds several (CNY, EUR, GBP, HKD, INR, USD). The planner used to try sources alphabetically, so an SGD shortfall would sell CNY even when the policy only lets USD conversions run without a person.

**Decision.** When several currencies can cover a shortfall, the planner tries first those the policy has a per-action auto-convert limit for (`plannerPolicy(...).autoConvertLimits`), then the others; alphabetical within each group. Whether the conversion is then auto-eligible is still decided by the amount against that limit. With no policy, or a limit for every source, the order is alphabetical as before. The planner stays pure and deterministic; `inputs_hash` is unchanged (the inputs are the same), and `content_hash` changes only for plans whose source changes.

**Tests.** `packages/domain/src/planner/scenarios.test.ts`, "conversion source (ADR 0021 amendment 1)".

## Amendment 2 (2026-11-15): executing an alternate payout

Found in the M3-07 live run: the approved alternate payout was refused `ALREADY_SENT` and returned to PROPOSED, because the payout executor (M3-03) refused any payment that already had a transfer, and a held payment always has one (rule 2).

**Decision.** A payout approved from a plan action with reason `PAYOUT_ALTERNATE_FOR_HELD` for that payment sends a **new** transfer (its own attempt and `request_id`) for the held payment's obligation, bound to the same approval hash. It is refused `NOT_IN_FLIGHT` if the payment has no transfer. The new transfer is recorded on the attempt and the audit entry (`alternateFor`), and is **not** applied to the payment: the payment keeps its held transfer, whose status stays the money status (ADR 0006); `applyFetchedTransfer` already ignores a transfer that is not the payment's own. A plain payout of an already-sent payment is still refused `ALREADY_SENT`. Whether the held transfer is later returned is outside Carnet's control; both transfers can complete (stated risk: the payee may be paid twice, which the owner accepts by approving the alternate payout).

**Tests.** `packages/db/src/executors/executors.int.test.ts`, "an alternate payout for a held payment sends a new transfer and leaves the held one on the payment".
