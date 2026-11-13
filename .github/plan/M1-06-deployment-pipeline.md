---
title: "M1-06 · Deployment pipeline: Dockerfile web/worker, platform deploy, env, /healthz, migrations on deploy, rollback"
milestone: "M1 · Walking Skeleton"
labels: ["infra"]
blocked_by: ["M1-02", "M0-07"]
estimate: "6h"
resources: ["DEPLOY"]
needs: ["P-02", "P-05", "P-17", "P-21", "P-22"]
---

## Context

ADR 0014: one Docker image (Next.js standalone) runs in `web` or `worker` mode on any platform that
offers a container, `DATABASE_URL`, environment variables, a public HTTPS URL, `/healthz`, a restart
policy and at least one always-on worker. The platform (Railway, Render or AWS) was chosen in M0-07,
which is expected to record that choice as a follow-on ADR (referred to in the plan as ADR 0019); this
ticket implements that decision and does not re-open it. Risks: "Hosting undecided" (closed by
M0-07) and the stable webhook URL for the Airwallex subscription (M0-05 needs it). Rubric: R9 (a
working deployed demo) and the always-on judging window.

## Scope

1. **Dockerfile** (multi-stage, Node 24, Next `output: standalone`, non-root user, `.dockerignore`)
   whose entrypoint reads `PROCESS_MODE=web|worker` and starts the web server or the worker loop
   from M1-05. Image contains no `.env` and no secrets.
2. **Health**: `GET /healthz` (web) returns 200 with `{status, version, db: ok}` after a cheap
   `SELECT 1`, 503 when the DB is unreachable; worker liveness is the heartbeat log line plus a
   platform health command or a heartbeat row, whichever M0-07 verified the platform supports.
3. **Platform deploy** per the M0-07 decision: platform config as code where the platform allows
   (for example `railway.json`, `render.yaml` or the equivalent), two services (web, worker) from
   one image, managed Postgres, region as decided in M0-07, restart policy always. Environment wiring
   documented by key name in `docs/deployment.md` (no values): `DATABASE_URL`,
   `DATABASE_MIGRATION_URL`, `PROCESS_MODE`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
   `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY`, `AIRWALLEX_WEBHOOK_SECRET`, `AIRWALLEX_BASE_URL`,
   `AIRWALLEX_FILES_URL`, `ANTHROPIC_API_KEY`, and the seed password keys.
4. **Migrations on deploy**: a release step runs `db:migrate` with the migration role before the new
   web and worker start; a failed migration fails the deploy and leaves the old version serving.
5. **`scripts/setup.ts`**: ONE idempotent script that (a) runs migrations if asked, (b) creates the
   app role grants (M1-02 `roles.sql`), (c) calls `seedDemoUsers` and creates the demo business with
   the demo counterparty/beneficiary record placeholder. Safe to run any number of times; dataset
   loading comes later (M0-08 dataset is loaded in M2).
6. **CD from `main`**: the mechanism M0-07 chose (platform Git integration or a GitHub Actions
   workflow gated on green CI). Rollback instructions in `docs/deployment.md`: redeploy previous
   image tag, and how to roll back a migration (forward-fix policy stated, with the one manual
   down-step procedure for the latest migration).
7. **Verify, not assume**, the chosen platform's idle-sleep, backup and database-limit behaviour
   against M0-07's notes and record anything that differs in `docs/deployment.md`.
8. Stable webhook URL: record `https://<host>/api/webhooks/airwallex` as the permanent path in
   `docs/deployment.md` (host from the platform, no value committed if it is secret-adjacent).

## Out of scope

- Creating the Airwallex webhook subscription (owner step, done in M0-05/M1-08)
- Application features, dataset load, custom domain
- Scaling beyond one web and one worker instance

## Acceptance Criteria

- [ ] `docker build` succeeds locally; `docker run -e PROCESS_MODE=web` answers `GET /healthz` 200 with the local DB; `PROCESS_MODE=worker` logs a heartbeat within 35 s; an unknown `PROCESS_MODE` exits non-zero
- [ ] Image size and user are checked: runs as non-root; `docker run ... ls /app` shows no `.env`
- [ ] The deployed URL answers `GET /healthz` with 200 (curl in the gate, URL from `DEPLOY_URL`)
- [ ] The deployed worker logs a heartbeat in the last 2 minutes (platform log command or heartbeat row, documented)
- [ ] A merge to `main` deploys automatically (evidence: the deployment id/log line for the latest `main` commit posted on the issue); a deliberately failing migration on a throwaway branch/test database fails the release step without replacing the running version (shown by log, no production data touched)
- [ ] `scripts/setup.ts` run twice against a fresh DB yields the same row counts; the second run exits 0
- [ ] Rollback instructions executed once by redeploying the previous image tag; `/healthz` still 200 afterwards
- [ ] `docs/deployment.md` lists every env key by name, no values, and passes `./scripts/check-no-secrets.sh`
- [ ] The webhook URL is stable across two consecutive deploys (same host/path)

## Deliverables

- `Dockerfile`, `.dockerignore`, platform config file(s), `.github/workflows/deploy.yml` if CD uses Actions
- `apps/web/src/app/healthz/route.ts`, `apps/web/src/worker/entry.ts` (mode switch)
- `scripts/setup.ts`, `docs/deployment.md`

## Validation Gate

```bash
set -euo pipefail
docker compose up -d postgres
docker build -t carnet:test .
docker run --rm --entrypoint id carnet:test -u | grep -v '^0$'
CID=$(docker run -d -e PROCESS_MODE=worker -e DATABASE_URL="$DATABASE_URL" --network host carnet:test)
sleep 35; docker logs "$CID" 2>&1 | grep -ci heartbeat; docker rm -f "$CID"
! docker run --rm -e PROCESS_MODE=bogus carnet:test
export SEED_OWNER_PASSWORD="$(openssl rand -hex 12)" SEED_APPROVER_PASSWORD="$(openssl rand -hex 12)" SEED_JUDGE_PASSWORD="$(openssl rand -hex 12)"  # seedDemoUsers aborts without them
npx tsx scripts/setup.ts && npx tsx scripts/setup.ts
curl -fsS "${DEPLOY_URL:?set DEPLOY_URL to the deployed origin}/healthz"
./scripts/check-no-secrets.sh
```

## Handoff

M1-08 (deployed environment, webhook URL, `DEPLOY`), M0-05 follow-ups, M1-09 (scheduled health check
target). Comment on the issue: the deployed origin, platform name and region, how to read worker
logs, the rollback command, the env key list, and any platform behaviour found (idle sleep, backups).
