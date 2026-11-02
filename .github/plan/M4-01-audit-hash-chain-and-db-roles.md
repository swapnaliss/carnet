---
title: "M4-01 · Audit hash chain, DB roles, chain verify on /ops"
milestone: "M4 · Governance & Evals"
labels: ["security"]
blocked_by: ["M3-GATE"]
estimate: "5h"
resources: []
needs: []
---

## Context

R3 and R6 ask for a system that moves money or state with approvals that can be proven afterwards. The STRIDE row "Tampering: editing audit history" and "Repudiation: I never approved that" (`docs/architecture.md` §8) are answered by [ADR 0013](../../docs/adr/0013-audit-log-hash-chain.md): every audit row carries `prev_hash` and `hash`, the chain is verified on `/ops`, and the application connects with a role that cannot alter or drop the table, its trigger, or truncate it, while a separate migration role owns the schema. A trigger alone is not enough because the owning role can remove it. Earlier milestones write audit rows; this ticket makes the log tamper-evident and tamper-resistant and proves it with tests.

## Scope

1. **One place computes the hash.** A single module in `packages/db` (or `packages/domain` for the pure hash function, with the DB call in `packages/db`) builds each row: `hash = SHA-256(canonical JSON of {prev_hash, at, actor_type, actor_id, action, subject, data})`. The genesis row uses a fixed documented `prev_hash`. No other code computes or writes `hash`.
2. **Append-only API.** `appendAudit(tx, entry)` is the only write path. It takes the chain tail under a lock (`SELECT … FOR UPDATE` on a single-row chain-head table or an advisory lock) so concurrent appends cannot fork the chain, and is called inside the same transaction as the state change it records. There is no update or delete function. Existing callers from M1-M3 are switched to it.
3. **Roles.** Two roles: a migration role that owns the schema and runs `drizzle-kit` migrations, and the app/worker role with `SELECT, INSERT` on `audit_log` only (no `UPDATE`, `DELETE`, `TRUNCATE`, no ownership, no `CREATE` on the schema). A migration creates the roles' grants idempotently; `docker compose` local Postgres and the deploy pipeline use `DATABASE_MIGRATION_URL` for migrations and `DATABASE_URL` for the running app (use the names M1-02 chose if they differ). A defence-in-depth trigger rejecting `UPDATE`/`DELETE` is kept, but the tests prove the role grants hold without it.
4. **Verification function.** `verifyAuditChain(db, {from?, to?})` recomputes every hash and link and returns `{ok, checked, firstBadId?, reason}` with reasons `HASH_MISMATCH`, `LINK_MISMATCH`, `GAP` (non-contiguous sequence), `GENESIS_MISMATCH`.
5. **`/ops` display.** The `/ops` page shows chain status (OK or BROKEN with the first bad row id and reason), the number of rows verified, the head hash (shortened) and the time of the last verification. Verification also runs in the worker on a schedule and the result is stored, so the page does not recompute on every load for a large log. Owner-only, like the rest of `/ops`. Strings come from the typed strings module.
6. Every audit write includes the agent's own identity for model-driven steps (`actor_type = agent`), per `docs/architecture.md` §10.

## Out of scope

- External anchoring of the head hash (a ledger service or notarisation): ADR 0013 rejects an external ledger.
- Row-level security (a recorded "not built" trigger in `docs/architecture.md` §13).
- Redesigning the audit event vocabulary written by earlier tickets beyond routing it through `appendAudit`.
- The kill-switch and spend-cap audit events themselves (written by M4-02 through this API).

## Acceptance Criteria

- [ ] `grep` over the repo shows the hash is computed only inside the audit module, and no code path other than `appendAudit` inserts into `audit_log` (a test greps the source tree and fails otherwise)
- [ ] Appending 200 entries concurrently from several connections yields a valid, gap-free, single chain (`verifyAuditChain` returns `ok`)
- [ ] Connected as the app role against a real Postgres: `UPDATE audit_log`, `DELETE FROM audit_log`, `TRUNCATE audit_log`, `DROP TABLE audit_log`, `ALTER TABLE audit_log`, `DROP TRIGGER` and `CREATE OR REPLACE` of the audit trigger function each fail with a permission error
- [ ] Tamper tests (run as the migration/superuser role, simulating a privileged attacker): a modified row is reported `HASH_MISMATCH` with the right row id; a deleted middle row is reported `LINK_MISMATCH` or `GAP`; a deleted last row is detected by the stored head; a reordered pair is reported; each case is detected by `verifyAuditChain`
- [ ] Appending an entry in a transaction that rolls back leaves no row and does not advance the chain head
- [ ] `/ops` shows OK for an untampered log and BROKEN with the offending row id after a tamper in a Playwright test; the page is not reachable by a non-owner (403 or redirect)
- [ ] Migrations apply from scratch twice (idempotent grants) and the app role cannot run `drizzle-kit` migrations
- [ ] `./scripts/landing-checks.sh` passes

## Deliverables

- `packages/db/src/audit/` (append, hash, verify), role/grant migration under `packages/db/migrations/`
- `packages/db/test/audit-chain.test.ts`, `packages/db/test/audit-roles.test.ts`
- `/ops` chain panel in `apps/web` and its Playwright test
- Worker verification job and strings entries
- Short note on the role split in `docs/architecture.md` §5 if the final role names differ from the text

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"
docker compose up -d db
npm run db:migrate
npx vitest run packages/db/test/audit-chain.test.ts packages/db/test/audit-roles.test.ts
npx playwright test apps/web/e2e/ops-audit.spec.ts
# hash computed in one place, one writer
test "$(grep -rln "audit_log" packages apps --include=*.ts --exclude-dir=node_modules --exclude-dir=test --exclude-dir=migrations | grep -v 'packages/db/src/audit/' | grep -vc 'schema')" -eq 0
./scripts/landing-checks.sh
```

## Handoff → M4-02, M4-04, M4-GATE, M5-01

Comment on the issue: audit module path, the two role names and env keys, how to run the verifier, and the exact tamper cases proven. M4-02 appends kill-switch and cap events through `appendAudit`; M4-04 reuses the role test as the "tampering" STRIDE check; the gate re-runs the tests; M5-01 may claim only what these tests show.
