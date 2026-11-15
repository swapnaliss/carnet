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
