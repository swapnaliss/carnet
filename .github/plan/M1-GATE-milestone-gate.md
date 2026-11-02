---
title: "M1-GATE · Milestone gate: Walking Skeleton"
milestone: "M1 · Walking Skeleton"
labels: ["gate"]
blocked_by: ["M1-01", "M1-02", "M1-03", "M1-04", "M1-05", "M1-06", "M1-07", "M1-08", "M1-09", "M1-10"]
estimate: "1h"
resources: []
needs: ["P-02", "P-05", "P-06"]
---

## Context

Closes M1 · Walking Skeleton. The gate proves the skeleton works from a clean state, not on a dirty
worktree: auth, database, adapter, webhook, worker and deployment exist and agree, the recorded
fixtures replay the skeleton without network, and one real production run is on record (R0, R5,
risks "Timeouts or crashes around money calls" and "Hosting undecided"). It is run with `/gate 1`,
never spawned by `/start-milestone`.

## Scope

1. **Clean state**: fresh clone of `main` into `$TMPDIR`, `npm ci`, `make reset` (drops and recreates
   the local database), migrations with the migration role, `scripts/setup.ts` seed.
2. `./scripts/landing-checks.sh` at the full level.
3. All integration tests against Docker Postgres.
4. **Recorded-fixture replay of the skeleton**: replays `fixtures/airwallex/m1-skeleton/` (from
   M1-08) through the signature-verified webhook route and the worker with the adapter stubbed from
   fixtures, asserting the final projected status equals the recorded one. No network.
5. **Deployed checks**: `GET $DEPLOY_URL/healthz` is 200; the worker heartbeat is recent; the evidence
   from M1-08 (`docs/evidence/m1-skeleton/` screenshots and run log) exists and the run log shows an
   `ExecutionAttempt` ending `CONFIRMED` and a webhook-driven status update.
6. `python3 scripts/check-prereqs.py` has no missing item that M1 needed; `python3
   scripts/check-plan.py` passes.
7. Verify every `frontend` ticket in M1 (M1-07, M1-08) has a recorded `ui-reviewer` PASS on its issue.

## Out of scope

- Fixing failures (open a finding with `/backlog` or reopen the owning ticket); adding features
- The post-gate backlog sweep (non-blocking, separate)

## Acceptance Criteria

- [ ] A fresh clone builds and migrates from zero with no manual step beyond documented env keys
- [ ] `./scripts/landing-checks.sh` exits 0
- [ ] Integration test suites for `packages/domain`, `packages/db`, `packages/airwallex`, `apps/web` exit 0
- [ ] The fixture replay passes with the network disabled (run with a fetch guard)
- [ ] The deployed `/healthz` returns 200 and the recorded evidence files exist and are non-empty
- [ ] The run log shows one real skeleton run with `attempt_status` `CONFIRMED`
- [ ] `ui-reviewer` PASS comments exist on M1-07 and M1-08
- [ ] `./scripts/check-no-secrets.sh` exits 0 on the clean clone
- [ ] Gate result and the timing of each step posted on the issue

## Deliverables

- Gate report posted as an issue comment (commands, timings, pass/fail per criterion)
- `scripts/gate-m1.sh` (the commands below, so the gate is repeatable)

## Validation Gate

```bash
set -euo pipefail
W="$TMPDIR/carnet-gate-m1"; rm -rf "$W"
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
curl -fsS "${DEPLOY_URL:?deployed origin}/healthz"
test -s docs/evidence/m1-skeleton/run-log.json
jq -e '.attempt_status=="CONFIRMED" and .transfer_id' docs/evidence/m1-skeleton/run-log.json
ls docs/evidence/m1-skeleton/*.png
python3 scripts/check-plan.py
./scripts/check-no-secrets.sh
```

## Handoff

Unblocks M2 (all M2 tickets whose chain starts at M1-02, M1-03, M1-04, M1-05, M1-07 and M1-10). Comment
on the issue: pass/fail table, the deployed origin, the skeleton transfer id, the fixture set name, and
any finding logged to BL-01. Remind that `AIRWALLEX_SANDBOX` and `DEPLOY` were released by M1-08.
