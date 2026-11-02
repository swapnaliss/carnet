---
title: "M1-02 · DB schema, migrations, repositories, app/migration roles"
milestone: "M1 · Walking Skeleton"
labels: ["backend"]
blocked_by: ["M1-01"]
estimate: "6h"
resources: []
needs: []
---

## Context

ADR 0002 (Postgres through a plain `DATABASE_URL`, `pg`, Drizzle 0.45.4, drizzle-kit 0.31.11) and ADR
0013 (the application role cannot alter or drop the audit table or truncate it; a separate migration
role owns DDL). ADR 0012 requires every repository call to carry a context with `business_id`
(tenancy, risk: cross-tenant leak). This ticket supports R3 and R6 later (attempts, approvals) and
every M1 flow now. Per-worker isolated databases keep parallel workers from colliding.

## Scope

1. **Schema** in `packages/db/src/schema/*` for the tables of `docs/architecture.md` §5 that M1 needs:
   `businesses`, `users` (domain columns; credential tables come from better-auth in M1-04),
   `counterparties`, `payments`, `webhook_events` (unique `provider_event_id`), `outbox_jobs`,
   `idempotency_keys`, `rate_limits`, `audit_log` (`prev_hash`, `hash` columns, no hashing logic yet:
   M4-01), `system_flags`, and `execution_attempts` (ADR 0007 needs it for M1-08; unique
   `request_id`). Money columns are `*_minor bigint` plus `currency char(3)`. Indexes per §5.
2. **Migrations** with drizzle-kit, committed SQL, applied by `npm run db:migrate` using the
   migration role. A check that the migration folder and the schema agree (`drizzle-kit check`).
3. **Roles**: migration owner role (DDL; owns tables) and app role (SELECT/INSERT/UPDATE/DELETE on
   tables as needed; INSERT and SELECT only on `audit_log`; no ALTER, DROP or TRUNCATE; cannot create
   roles or objects). Created by an idempotent SQL step run once with the admin connection.
4. **Repository layer** in `packages/db/src/repos/*`: every function takes `ctx: { businessId }` first
   and scopes by it; there is no function that reads a tenant table without a context. Repos return
   domain types from M1-01 (Money, ids).
5. **Test harness**: Docker Postgres (`postgres:17-alpine` from `docker compose`), each Vitest worker
   creates its own database (`carnet_test_<worker>`), migrates it, and drops it on exit; uses
   `DATABASE_URL` and `DATABASE_MIGRATION_URL` keys only.
6. `system_flags` read helper used later by the kill switch (M1-05 reads it).

## Out of scope

- Hash computation and chain verification (M4-01), agent/approval/document/RFI tables (their tickets)
- better-auth tables (M1-04), seed data (M1-06 `scripts/setup.ts`)
- Row-level security (rejected in ADR 0012)

## Acceptance Criteria

- [ ] `npm run db:migrate` on an empty database creates all listed tables; running it twice is a no-op
- [ ] `drizzle-kit check` exits 0 (schema and migrations agree)
- [ ] Integration test: connected as the app role, `ALTER TABLE audit_log ...`, `DROP TABLE audit_log`, `TRUNCATE audit_log` and `UPDATE audit_log` each fail with a permission error; `INSERT` and `SELECT` succeed
- [ ] Integration test: the app role cannot `CREATE TABLE` or `ALTER` any table
- [ ] Cross-tenant tests: for every repository function, business A's context cannot read, update or delete business B's rows (parameterised over the repo list; a test fails if a repo function lacks a `ctx` argument)
- [ ] `webhook_events.provider_event_id` and `execution_attempts.request_id` uniqueness violations are raised as typed errors
- [ ] Two Vitest workers run concurrently against separate databases without interference (a test writes the same unique key from both)
- [ ] Money round-trips: a `bigint` minor value above 2^53 stored and read back unchanged
- [ ] `npm run test -w packages/db` exits 0 against Docker Postgres

## Deliverables

- `packages/db/src/schema/*.ts`, `packages/db/src/repos/*.ts`, `packages/db/src/client.ts`
- `packages/db/migrations/*.sql`, `packages/db/drizzle.config.ts`, `packages/db/sql/roles.sql`
- `packages/db/test/*.test.ts` and `packages/db/test/harness.ts`
- `.env.example` entries (keys only): `DATABASE_URL`, `DATABASE_MIGRATION_URL`

## Validation Gate

```bash
set -euo pipefail
docker compose up -d postgres
npm run db:migrate -w packages/db
npm run db:migrate -w packages/db          # second run is a no-op
npx drizzle-kit check --config packages/db/drizzle.config.ts
npm run test -w packages/db
npm run typecheck -w packages/db
./scripts/check-no-secrets.sh
```

## Handoff

M1-04 (auth tables and users), M1-05 (webhook_events, outbox_jobs, execution_attempts), M1-06
(migrations on deploy, seed), M1-10 (rate_limits), and M2-00. Comment on the issue: the repo function
index, the two env key names, how a test obtains an isolated database, and the exact role grants.
Hot file: `packages/db/src/schema/*`; later tickets add tables by new migration, never by editing an
applied one.
