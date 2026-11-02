---
title: "M3-02 · Planner (pure) + property tests: reserve floor, fees, per-currency, held funds unavailable"
milestone: "M3 · Hold-Aware Planning"
labels: ["backend"]
blocked_by: ["M1-01"]
estimate: "8h"
resources: []
needs: []
---

## Context

When a payment is held for review, the cash it ties up is not available, and payroll due on Friday can be short. The planner is the heart of pillar 3 (hold-aware planning) and of rubric R2 (the decision changes with new information) and R5 (code enforces, the model does not judge money). Per `docs/architecture.md` the planner is a pure function with no I/O; held funds are unavailable until M0 spike output shows otherwise (project risk "Held funds are not visible in balances"). Per ADR 0001 it lives in `packages/domain` and imports no framework, SDK or I/O. Per ADR 0009 there is no model in it.

## Scope

1. **`plan(inputs): Plan`** in `packages/domain/src/planner/`, a total, deterministic function over zod-validated inputs:
   - `balances`: per business, per currency, available minor units (as read from Airwallex; never summed across currencies or businesses).
   - `held`: transfers currently held with their source currency and amount; their funds are treated as **unavailable** (subtracted from available, never added back) until a config flag `heldFundsVisibleInBalances` set from the M0 spike result says the balance already excludes them.
   - `obligations`: payee, amount minor, currency, `due_at`, criticality (1..3 or `UNCONFIRMED`, per M3-01), with `payment_id` where one exists.
   - `reserveFloor`: per currency, minor units.
   - `fees`: flat SWIFT fee per payout per currency and the FX fee/spread assumption, **read from a config object passed in** (loaded from `config/fees.json`; the builder guide says EUR 12.85 per SWIFT payout in the sandbox, to be confirmed by the M0-03 fixtures; no fee value is a constant in code).
   - `fxRates`: indicative rates per currency pair with an `as_of` timestamp.
   - `policy`: version and hash (limits are evaluated in M3-03; the planner only labels which actions are eligible by amount).
   - `now`: passed in, never read from a clock.
2. **Output**: ordered `actions[]`, each one of `fund` (reserve cash for an obligation in its currency), `convert` (pair, sell/buy amounts in minor units including the SWIFT fee, indicative rate and rate bounds), `defer` (obligation, new proposed date), `escalate` (needs the owner, with the reason), `payout` (an alternate payout from a funded balance), each with a machine `reason_code`, structured `reason_facts` (the numbers used), and `needs_approval` (payouts and escalations always; conversions marked eligible-for-auto only by amount and floor, final check in M3-03).
3. **Rules**: obligations are processed by `(criticality asc, due_at asc, id)`; unconfirmed criticality is treated as criticality 1 (most protective) for the cash it reserves, never for deferral, and it is labelled; an obligation is deferred only if confirmed criticality 3 or 2 and its due date allows, and never when it is criticality 1; the reserve floor is never breached by any action sequence; a conversion's sell amount includes the SWIFT fee of the payout it funds; no cross-currency arithmetic without a `convert` action.
4. **Immutable plan revisions**: `Plan` carries `inputs_hash` (SHA-256 over canonical JSON of all inputs including config and `now`) and a content hash; a pure `nextRevision(previous, inputs)` returns the same plan object when `inputs_hash` is unchanged, otherwise revision + 1. Persistence (`plans`, `plan_actions` tables in `packages/db/src/schema/plans.ts`, a hot file) stores revisions append-only; no update path exists for a stored plan.
5. **Re-run on every event**: an outbox consumer (`packages/db` + worker handler) re-runs the planner on `airwallex.transfer.updated`, `airwallex.rfi.opened | answered | closed | reopened`, `payment.submitted`, balance refresh and obligation changes, and writes a new revision only when `inputs_hash` changed; emits `plan.revised` in the same transaction (outbox). The handler is idempotent on the event id.
6. **Property tests** (fast-check or Vitest's property support; add the package only if M0-02 did not, pinned exactly) over generated inputs: never breaks the reserve floor in any currency; never sums balances across businesses or currencies without a conversion action; never uses held funds (total spent per currency is at most available minus held); deterministic (same inputs give a byte-identical plan; input order permutations give the same plan); monotone with more cash (adding available cash in a currency never turns a `fund` into a `defer`/`escalate`, never reduces the funded set); idempotent revision hash; serialisation round-trip.
7. **Scenario tests** on fixtures built from M0-03/M0-04 balance outputs: payroll Friday with one held payment, held amount large enough that payroll in the payroll currency is short, other currency has cash: expect `convert` (cash to payroll currency including the SWIFT fee), `fund` payroll, an alternate `payout` for the held supplier payment from the funded balance, and `defer` of a confirmed criticality-3 bill. Further scenarios: no hold (plan unchanged vs the baseline), hold released (plan returns to baseline), unconfirmed criticality, floor so high nothing can convert (`escalate`), two businesses in the same database (no mixing).

## Out of scope

- Executing any action, policy limits, auto-approval, quotes (M3-03).
- Screens (M3-04), criticality proposal (M3-01), notifying anyone.
- Any model call or any network access.

## Acceptance Criteria

- [ ] `packages/domain` still imports nothing outside the language and `zod`: the domain import-lint rule passes and the planner folder has no `fetch`, `Date.now`, `Math.random` or `process.env` (test greps the folder).
- [ ] Each of the five properties passes at least 1,000 generated cases (seed printed on failure; fixed seed in CI).
- [ ] The payroll-Friday scenario test produces exactly: one `convert` including the SWIFT fee from config, a `fund` for payroll, an alternate `payout` and a `defer` of the criticality-3 bill; its reasons carry the numbers used.
- [ ] Changing the fee in `config/fees.json` changes the conversion amount in the plan (proves the fee is read from config).
- [ ] The same inputs yield the same `inputs_hash` and an identical plan; one changed balance yields a new revision with `revision + 1`; storing a revision twice is a no-op.
- [ ] Re-run handler: feeding the recorded event sequence from the M2 hold fixtures produces new revisions only when inputs changed, and replaying the same event twice produces no extra revision (integration test).
- [ ] An attempted update or delete of a stored plan row through the repository API does not exist (test asserts the exported surface), and the DB role used by the app has no UPDATE on `plans` (checked in M4-01; here the repository only inserts).

## Deliverables

- `packages/domain/src/planner/` (types, `plan.ts`, `revision.ts`, rules, zod schemas) and exports from `packages/domain/src/index.ts` (hot file)
- `config/fees.json` (and its zod loader outside `domain`)
- `packages/db/src/schema/plans.ts`, migration, plan repository, worker handler
- Tests: `packages/domain/src/planner/*.test.ts` (properties and scenarios), `fixtures/planner/` scenario inputs

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; OUT="$(mktemp -d "$TMPDIR/m3-02.XXXXXX")"
npx vitest run packages/domain/src/planner 2>&1 | tee "$OUT/planner.log"
grep -c 'property' "$OUT/planner.log"
! grep -rnE 'Date\.now|Math\.random|process\.env|fetch\(' packages/domain/src/planner --include='*.ts' --exclude='*.test.ts'
npm run lint -w packages/domain
TEST_DATABASE_URL="${TEST_DATABASE_URL:?set a throwaway database}" npx vitest run packages/db/src/plans
./scripts/landing-checks.sh --fast
```

## Handoff

- **M3-03** consumes `Plan.actions` (kinds, params, `needs_approval`, indicative rates and bounds) and the `plans` / `plan_actions` repositories to execute.
- **M3-04** renders plans, revisions and `reason_facts`; builds the before/after diff from two stored revisions.
- **M3-07** drives the live run through the re-run handler.
Post as an issue comment: the `plan()` input and output type names, the fee config shape and where EUR 12.85 comes from (cite the M0-03 fixture if confirmed, otherwise label it as from the builder guide), the held-funds flag and which M0 spike result it follows, the property list with case counts, and the rule for unconfirmed criticality.
