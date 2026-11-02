---
title: "M3-GATE · Gate"
milestone: "M3 · Hold-Aware Planning"
labels: ["gate"]
blocked_by: ["M3-01", "M3-02", "M3-03", "M3-04", "M3-05", "M3-06", "M3-07"]
estimate: "1h"
resources: []
needs: []
---

## Context

M3 completes the storyboard: the planner re-runs on a hold, FX auto-executes under a recorded policy, payouts need a bound approval, a follow-up reuses an approved answer, and a payee can see a generic status. The gate proves the milestone from a clean state before M4 (governance and evals) builds on it. It is run with `/gate 3`, never spawned by `/start-milestone`.

## Scope

From a clean state (fresh Docker Postgres, migrations, seed, `make down && make up`):

1. Every ticket M3-01..M3-07 is closed with its acceptance criteria met and its handoff comment posted.
2. Landing checks pass in full (`./scripts/landing-checks.sh`), including the secret scan.
3. Planner property tests pass (floor, per-currency, held funds, determinism, monotonicity) and the payroll-Friday scenario passes.
4. Executor tests pass (daily cap, quote reuse, duplicate `request_id`, timeout to UNKNOWN, crash recovery, kill switch).
5. Criticality injection evals pass on recorded responses; payee page tests pass.
6. The live-run evidence is present: `docs/evidence/m3-run.md`, `docs/evidence/m3-03-live.md`, screenshots, and `fixtures/replay/m3/`.
7. The deployed environment responds on `/healthz` and the web build succeeds.
8. Afterwards, the non-blocking backlog sweep is run by `/gate` and decisions go to the owner.

## Out of scope

- Any new feature, any fix beyond what makes an existing criterion pass (fixes go to the owning ticket).
- Re-running the live demo (the gate checks its recorded evidence; a re-run is only needed if the evidence is missing or a later change touched the money path).

## Acceptance Criteria

- [ ] All seven tickets M3-01..M3-07 are closed.
- [ ] `./scripts/landing-checks.sh` exits 0 from a clean clone state.
- [ ] Planner property and scenario tests pass.
- [ ] Executor and policy tests pass.
- [ ] Criticality eval (including injection cases) and payee status tests pass.
- [ ] `docs/evidence/m3-run.md`, `docs/evidence/m3-03-live.md`, at least nine screenshots under `docs/evidence/m3/` and a non-empty `fixtures/replay/m3/` exist and contain no secret.
- [ ] `python3 scripts/check-prereqs.py` reports no missing item for M3's resources.

## Deliverables

- A gate comment on this issue with the command outputs summarised and the evidence paths.

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; OUT="$(mktemp -d "$TMPDIR/m3-gate.XXXXXX")"
make down >/dev/null 2>&1 || true; make up
npm run db:migrate
./scripts/landing-checks.sh 2>&1 | tee "$OUT/landing.log"
npx vitest run packages/domain/src/planner 2>&1 | tee "$OUT/planner.log"
TEST_DATABASE_URL="${TEST_DATABASE_URL:?set a throwaway database}" \
  npx vitest run packages/db/src/executors packages/db/src/policies apps/web/src/app/status 2>&1 | tee "$OUT/exec.log"
npx vitest run --config packages/agent/vitest.evals.config.ts packages/agent/evals/criticality 2>&1 | tee "$OUT/evals.log"
test -s docs/evidence/m3-run.md
test -s docs/evidence/m3-03-live.md
test "$(ls docs/evidence/m3/*.png | wc -l)" -ge 9
test "$(find fixtures/replay/m3 -type f | wc -l)" -ge 5
./scripts/check-no-secrets.sh
python3 scripts/check-prereqs.py
: "${E2E_BASE_URL:?set to the deployed URL}"; curl -fsS "$E2E_BASE_URL/healthz" >/dev/null
```

## Handoff

- **M4-01..M4-06** start after this gate (`blocked_by: M3-GATE`): M4-01 chains the audit rows for plan actions, attempts and auto-approvals; M4-02 extends the kill switch checked in M3-03; M4-03 builds evals from the M3 fixtures; M4-05 serves `fixtures/replay/m3/`.
Post as an issue comment: pass or fail per criterion, the evidence paths, the planner property case counts, and the list of backlog items created by the sweep.
