#!/usr/bin/env bash
# M1 milestone gate (M1-GATE, issue #22): the ticket's Validation Gate as a repeatable script.
#   DEPLOY_URL=https://<deployed origin> ./scripts/gate-m1.sh
# Clones the current repository into $TMPDIR, so the gate runs from a clean state. Needs Docker and the
# local database keys (DATABASE_URL, DATABASE_MIGRATION_URL, SEED_*_PASSWORD) in the environment.
# The ticket's block has no `! cmd` lines; if one is ever added, write it as `if cmd; then echo ... >&2; exit 1; fi`
# (a `!` line under set -e can never fail).
set -euo pipefail
: "${DEPLOY_URL:?DEPLOY_URL (the deployed origin) is required}"
W="${TMPDIR:-/tmp}/carnet-gate-m1"; rm -rf "$W"
git clone --quiet "$(git rev-parse --show-toplevel)" "$W"
cd "$W"
npm ci
docker compose up -d postgres
make reset
npm run db:migrate -w packages/db
npx tsx scripts/setup.ts
./scripts/landing-checks.sh
npm run test --workspaces --if-present
npx tsx scripts/skeleton-replay.ts --fixtures fixtures/airwallex/m1-skeleton --offline
curl -fsS "${DEPLOY_URL%/}/healthz"
test -s docs/evidence/m1-skeleton/run-log.json
jq -e '.attempt_status=="CONFIRMED" and .transfer_id' docs/evidence/m1-skeleton/run-log.json
ls docs/evidence/m1-skeleton/screenshots/*.png
python3 scripts/check-plan.py
./scripts/check-no-secrets.sh
echo "gate-m1: PASS"
