# Deployment

Carnet runs as one Docker image in two modes (ADR 0014) on Render, Singapore (ADR 0019). The config as
code is `render.yaml`. This file names every environment key and never holds a value.

## Image

| Item | Value |
|---|---|
| Build | `docker build -t carnet .` (multi-stage, `node:24-alpine`; Next.js `output: standalone` plus esbuild bundles from `scripts/build-runtime.mjs`) |
| Entry | `node runtime/entry.mjs`, which reads `PROCESS_MODE`: `web` (default) starts the Next.js server on `PORT` (3000); `worker` starts the worker (a `worker heartbeat` log line every 30 s, M1-05's loop goes alongside); any other value exits 2 |
| Release step | `node runtime/release.mjs`: migrations as `carnet_migrator` (`DATABASE_MIGRATION_URL`), all pending migrations in one transaction |
| Setup | `node runtime/setup.mjs [--roles] [--migrate]` in the image, or `npx tsx scripts/setup.ts …` from a checkout |
| User | `node` (uid 1000), never root |
| Contents | `/app/apps` (standalone server and static files), `/app/node_modules` (traced), `/app/runtime` (bundles, `migrations/`, `roles.sql`). No `.env` (`.dockerignore`). Measured size: 302 MB (4 Nov 2026) |

## Health

- `GET /healthz` (web) returns `200 {"status":"ok","version":"<commit 12>","db":"ok","time":…}` after `SELECT 1` on the app role, with a 2 s deadline. It returns `503` with `"status":"unavailable"` and `"db":"unreachable"` when the database does not answer, or `"db":"unconfigured"` when `DATABASE_URL` is unset. `version` is `RENDER_GIT_COMMIT` (set by Render), else `APP_VERSION`, else `dev`. Render's health check uses this path, so a web instance that cannot reach the database is not put into service.
- The worker's liveness is its log line `{"process":"worker","message":"worker heartbeat","beats":n,"db":"ok"}`, written at start and every 30 s. Render background workers have no HTTP health check, so the log is the signal (see "Reading logs").

## Resources (names are fixed)

| Name | Type | Plan | Notes |
|---|---|---|---|
| `carnet-web` | web service, Docker | starter (paid, always on) | `healthCheckPath /healthz`, `preDeployCommand node runtime/release.mjs`, one instance |
| `carnet-worker` | background worker, Docker | starter (paid, always on) | same image, `PROCESS_MODE=worker`, one instance |
| `carnet-db` | Render Postgres 17 | basic-256mb, 1 GB disk | paid, so it has backups; internal connections only after setup |
| `carnet-secrets` | environment group | n/a | shared secret keys of both services |
| `carnet-placeholder` | free web service (M0-07) | free | delete after the Airwallex webhook moves to `carnet-web` |

Render restarts a crashed instance automatically, which is the restart policy.

## Environment keys (names only)

| Key | Service | Source |
|---|---|---|
| `PROCESS_MODE` | web `web`, worker `worker` | `render.yaml` |
| `NODE_ENV` | both, `production` | `render.yaml` |
| `DATABASE_URL` | both | `carnet_app` on `carnet-db`, internal host (secret) |
| `DATABASE_MIGRATION_URL` | web (release step) | `carnet_migrator` on `carnet-db`, internal host (secret) |
| `BETTER_AUTH_SECRET` | web | generated at setup, set through the Render API (secret) |
| `BETTER_AUTH_URL` | web | the public origin of `carnet-web` (`https://carnet-web.onrender.com`) |
| `TRUSTED_PROXY_HOPS` | web | `2`: Cloudflare and Render's router both append to `x-forwarded-for` (measured, see "Platform behaviour") |
| `AIRWALLEX_CLIENT_ID` | both | owner, sandbox key (secret) |
| `AIRWALLEX_API_KEY` | both | owner, sandbox key (secret) |
| `AIRWALLEX_WEBHOOK_SECRET` | web | owner, from the Airwallex webhook subscription (secret) |
| `AIRWALLEX_BASE_URL` | both | `https://api.sandbox.airwallex.com` |
| `AIRWALLEX_FILES_URL` | both | `https://files.sandbox.airwallex.com` |
| `ANTHROPIC_API_KEY` | both | owner (secret) |
| `SEED_OWNER_PASSWORD`, `SEED_APPROVER_PASSWORD`, `SEED_JUDGE_PASSWORD` | setup run | generated at setup into `carnet-secrets`; the owner reads them in the dashboard (Env Groups > `carnet-secrets`) and may replace them (secret) |
| `DATABASE_ADMIN_URL`, `DB_MIGRATOR_PASSWORD`, `DB_APP_PASSWORD` | `setup --roles` only, never on a service | admin connection of `carnet-db` and the two role passwords (secret) |
| `PORT`, `HOSTNAME` | image defaults `3000`, `0.0.0.0` | Render routes to `PORT` |
| `RENDER_GIT_COMMIT` | both | set by Render, reported as `version` |

Later tickets add keys from `.env.example` (limits, ops token) under the same rule. Values live only in
Render and the owner's password manager. Render CLI v2.35.0 has no command to set environment
variables, so use the dashboard (service > Environment, or Env Groups > `carnet-secrets`) or the Render
API (`PUT /v1/services/{id}/env-vars/{key}`, `PUT /v1/env-groups/{id}/env-vars/{key}`), piping a value from
its source without printing it.

## First-time setup (once per environment)

1. **Prerequisites:** a payment method on the Render workspace (P-22; the $50 credits are drawn first) and P-21 (the Render GitHub app can read the repo).
2. Create `carnet-db`, then (after step 4) `carnet-web` and `carnet-worker` and the env group `carnet-secrets` as in `render.yaml`: Blueprint sync from the dashboard, or the API with the same fields (`POST /v1/postgres`, `POST /v1/env-groups`, `POST /v1/services`; link a group with `POST /v1/env-groups/{id}/services/{serviceId}`). `render blueprints validate render.yaml` checks the file. Render appends a suffix to the database name (`carnet_xxxx`): read it from `GET /v1/postgres/{id}`.
3. Open `carnet-db` to the one IP that runs the setup (`PATCH /v1/postgres/{id}` with `ipAllowList`, a single `/32`, never `0.0.0.0/0`).
4. Roles (ADR 0013, `packages/db/sql/roles.sql`): with the admin (external) connection string in `DATABASE_ADMIN_URL` and freshly generated `DB_MIGRATOR_PASSWORD` and `DB_APP_PASSWORD`, run `npx tsx scripts/setup.ts --roles --hosted` (needs `psql`; set `PSQL` to a wrapper if it runs in a container). `--hosted` takes the branch of `roles.sql` for a non-superuser admin: Render's admin user cannot name SUPERUSER, CREATEDB, REPLICATION or BYPASSRLS in `ALTER ROLE` (error `Only roles with the SUPERUSER attribute may change the SUPERUSER attribute`), so the hosted roles rely on the `CREATE ROLE` defaults and the migrator does **not** get CREATEDB (it only serves the test harness). The script also makes the migrator the owner of the database and of schema `public`, which Render creates owned by the admin user (without this the first migration fails with `permission denied for schema public`).
5. Put `DATABASE_URL` (`carnet_app`) and `DATABASE_MIGRATION_URL` (`carnet_migrator`) on the **internal** host in `carnet-secrets`, with `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `TRUSTED_PROXY_HOPS` and the three `SEED_*` keys, then deploy. The release step creates the schema.
6. Seed on Render as a one-off job: `POST /v1/services/{carnet-web id}/jobs` with `{"startCommand":"node runtime/setup.mjs"}`. It uses the service's environment, and is idempotent.
7. **Close the database again:** `PATCH /v1/postgres/{id}` with `{"ipAllowList": []}`, and check `render postgres get <id> -o json --confirm` shows `"ipAllowList": []` under `data`. Connections from `carnet-web` and `carnet-worker` use the internal host and keep working.
8. The owner sets `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY`, `AIRWALLEX_WEBHOOK_SECRET` and `ANTHROPIC_API_KEY` in `carnet-secrets`, moves the Airwallex webhook subscription to the URL below, then deletes `carnet-placeholder`. Until the two Airwallex keys exist, `carnet-worker` runs **degraded**: it logs `worker heartbeat` with `"degraded":true` and processes no jobs (`apps/web/src/worker/entry.ts`).
9. Branch: while verifying, the services build the ticket branch with auto-deploy off. Before the merge is relied on, set `branch: main` and `autoDeployTrigger: checksPass` on both services (`PATCH /v1/services/{id}`).

## Continuous deployment

Each service uses `branch: main` with `autoDeployTrigger: checksPass`: Render deploys a commit on `main`
only after its GitHub checks (`ci`) pass. On `carnet-web` the deploy runs the release step first.
A failing migration exits 1, Render marks the deploy failed, and the running version keeps serving.
Drizzle applies pending migrations in one transaction, so a failed release leaves the schema as it was.
The worker deploys the same commit; it never migrates.

## Reading logs

- CLI: `render logs -r <carnet-worker id> --limit 50 -o text`, then look for `worker heartbeat`. Find the id with `render services -o json`.
- API: `GET /v1/logs?ownerId=<workspace id>&resource=<service id>&text=heartbeat&limit=5`.
- Dashboard: carnet-worker > Logs.

A heartbeat older than 2 minutes means the worker is down.

## Rollback

- **Code:** redeploy the previous successful deploy. Dashboard: carnet-web > Events > that deploy > Rollback. API: `POST /v1/services/{id}/rollback` with `{"deployId":"<previous deploy id>"}`, after listing them with `render deploys list <service id> -o json`. Do the same for `carnet-worker`. A rollback does not re-run the migrations.
- **Schema (forward-fix policy):** migrations are additive and never edited once applied, so code one deploy back still runs on the newer schema. A bad migration is fixed by a new migration. For the one manual down-step on the latest migration only:
  1. Roll the code back first (above).
  2. Connect as `carnet_migrator`.
  3. In one transaction, run the inverse DDL of the latest `packages/db/migrations/NNNN_*.sql`, then `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations)`.
  4. Revert the migration file on `main` so the next deploy does not re-apply it.

## Webhook URL (permanent)

`https://carnet-web.onrender.com/api/webhooks/airwallex`. The host is Render's `onrender.com` name for
`carnet-web`. It is fixed by the service name and does not change between deploys. No custom domain.

## Platform behaviour

| Topic | M0-07 note | Found in M1-06 (5 Nov 2026) |
|---|---|---|
| Paid resources | Covered by the $50 credits | **The Render API and Blueprint validation refuse paid resources without a payment method on file** (`402 Payment information is required …`, `need_payment_info`). The credits alone were not enough; the owner added a card (P-22) and the credits are drawn first. |
| Created plans | n/a | `carnet-web` starter, `carnet-worker` starter, `carnet-db` basic_256mb (1 GB disk, PG 17), all Singapore. API responses carry no prices. |
| Pre-deploy | n/a | Set as `serviceDetails.envSpecificDetails.preDeployCommand`. A failing one gives deploy status `pre_deploy_failed`; the previous live deploy keeps serving. |
| Database access | n/a | A new database has an **empty** `ipAllowList`, which means internal connections only. The external host answers `SSL connection has been closed unexpectedly` until an IP is allowed. |
| Database name | n/a | `databaseName: carnet` became `carnet_681c` (a suffix is added). |
| Admin user | n/a | `carnet_admin` has CREATEROLE and CREATEDB but is not a superuser; see First-time setup, step 4. |
| Client IP | `TRUSTED_PROXY_HOPS` to be measured | Measured: with a spoofed `x-forwarded-for`, the counted address was a Cloudflare address at `TRUSTED_PROXY_HOPS=1` and the caller's real address at `2`; the spoofed entry was ignored. Two proxies append to the header, so the value is `2`. |
| Idle sleep | Free instances sleep after 15 min; paid ones do not | Unverified: not tested after a long idle period. Paid instances are documented as always on. |
| Backups | Paid Postgres has point-in-time recovery | `GET /v1/postgres/{id}/recovery` returned `BACKUP_NOT_READY` right after creation. Not verified further. |
| Environment variables | CLI cannot set them | Confirmed (Render CLI v2.35.0); the API sets them (`PUT /v1/env-groups/{id}/env-vars/{key}` with `{"value": …}`). |
