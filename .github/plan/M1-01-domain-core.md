---
title: "M1-01 · Domain core: money, ids, payment projection over all 11 transfer statuses, property tests"
milestone: "M1 · Walking Skeleton"
labels: ["backend"]
blocked_by: ["M0-GATE"]
estimate: "6h"
resources: []
needs: []
---

## Context

R5 ("code enforces, model judges") needs a pure domain core that every later ticket imports. Two ADRs
land here: ADR 0002 (money as integer minor units, decimal strings only at the Airwallex boundary) and
ADR 0006 (payment status is a projection of the transfer and the RFI). Risk §10 "Timeouts or crashes
around money calls" and the out-of-order webhook problem are mitigated by making `project()` total and
tested with permuted event orders. `packages/domain` imports no framework, SDK or I/O
(`docs/engineering-standards.md`).

## Scope

In `packages/domain` (pure TypeScript 5.9.3, zod 4.6.7 as the only runtime dependency):

1. **Money**: `Money { minor: bigint, currency }`, a currency exponent table (at least USD, EUR, GBP,
   AUD, SGD, HKD, CNY, CAD, NZD, JPY with exponent 0; every currency seen in the M0-03/M0-04 fixtures),
   add/subtract/compare/negate with same-currency guards, `parseMajor(string, currency)` and
   `formatMajor(Money)` for the Airwallex boundary (decimal strings, no floats, rejects too many
   decimals and non-numeric input), and a split/allocate helper that never loses a minor unit.
2. **Ids**: branded string types and generators for the entities in `docs/architecture.md` §2/§5
   (business, user, payment, counterparty, rfi, attempt, approval, run) plus `RequestId` (the
   Airwallex `request_id`, generated once per intent).
3. **Status projection**: `TransferStatus` as a union of all eleven statuses (`IN_APPROVAL`,
   `APPROVAL_RECALLED`, `APPROVAL_REJECTED`, `APPROVAL_BLOCKED`, `SCHEDULED`, `OVERDUE`, `PROCESSING`,
   `SENT`, `PAID`, `FAILED`, `CANCELLED`), a status `rank`, and the total function
   `project(transferStatus, openRfi)` returning `{ view, held, final }`. "Held" is a flag, not a
   status. An RFI input never yields `SENT`, `PAID` or `FAILED`. `applyTransferUpdate(stored, incoming)`
   ignores an incoming update whose `updated_at` or rank is older than the stored one (ties on equal
   `updated_at` resolve by rank) and returns an `incident` marker for `PAID` to `FAILED`.
4. **Shared zod base schemas and the error format**: id schemas, `MoneySchema` (wire form: decimal
   string plus currency), pagination cursor schema, ISO timestamp schema, and the one API error shape
   `{ error: { code, message, details?, request_id } }` with a closed code enum (ADR 0004).
5. Biome-clean, `tsc --noEmit` clean, public surface exported from `packages/domain/src/index.ts`.

## Out of scope

- Approval hash canonicalisation (M2-07), planner (M3-02), policy (M3-03)
- Any I/O, database types, Airwallex wire types (M1-03 maps the wire into these domain types)
- FX rate math beyond Money arithmetic

## Acceptance Criteria

- [ ] `packages/domain` has no import of `pg`, `drizzle`, `next`, `react`, an SDK, `fs` or `fetch` (a test greps the sources and fails otherwise)
- [ ] Money: `parseMajor("100.50","USD")` is `10050n` minor; `parseMajor("1000","JPY")` is `1000n`; `formatMajor` round-trips every currency in the table; 3 decimals for USD, non-numeric and negative-zero forms are rejected; unit tests pass
- [ ] Property test (fast-check or hand-rolled generator, 1,000 runs): `formatMajor(parseMajor(x)) === x` for canonical inputs; `allocate(total, n)` sums exactly to `total`; adding Money of different currencies throws
- [ ] `project()` is total: a test enumerates all 11 statuses x {no RFI, open RFI} and asserts a defined result for each (22 cases) with an exhaustive `switch` that fails type-checking if a status is added
- [ ] No RFI input produces `SENT`, `PAID` or `FAILED`; `held` is true only when an RFI is open and the transfer is `SCHEDULED`, `PROCESSING` or `SENT`
- [ ] Property test over permuted event orders (all permutations of a 6-event sequence, plus 1,000 random shuffles with duplicates): the final stored state equals the state from the in-order sequence whenever the events carry increasing `updated_at`; a stale event never overwrites a newer one; duplicate application is idempotent
- [ ] `PAID` followed by `FAILED` returns an incident marker; `FAILED` followed by an older `PAID` is ignored
- [ ] Error format: a schema test shows every code in the enum serialises to the documented shape and invalid shapes are rejected
- [ ] `npm run test -w packages/domain` and `npm run typecheck -w packages/domain` exit 0

## Deliverables

- `packages/domain/src/money.ts`, `ids.ts`, `status.ts`, `schemas.ts`, `errors.ts`, `index.ts`
- `packages/domain/test/money.test.ts`, `status.property.test.ts`, `purity.test.ts`, `errors.test.ts`
- `packages/domain/package.json` (workspace package; exact pins)

## Validation Gate

```bash
set -euo pipefail
npm run typecheck -w packages/domain
npm run test -w packages/domain
npx biome check packages/domain
# purity: no I/O or framework imports
! grep -rEn "from ['\"](pg|drizzle-orm|next|react|node:fs|node:http|@anthropic-ai/sdk)" packages/domain/src
# the exhaustive status test exists and covers 11 statuses
grep -c "APPROVAL_BLOCKED" packages/domain/src/status.ts
```

## Handoff

Unblocks M1-02 (money and status types for columns), M1-03 (adapter maps wire to these types), M1-05
(handlers call `applyTransferUpdate`), and later M2-07 and M3-02. Comment on the issue: the exported
names (`Money`, `project`, `applyTransferUpdate`, `ApiError`), the currency table location, and the
rank order chosen for the 11 statuses so M1-05 and the fixtures agree.
