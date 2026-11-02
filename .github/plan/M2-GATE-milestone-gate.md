---
title: "M2-GATE · Milestone gate"
milestone: "M2 · Evidence to Answer"
labels: ["gate"]
blocked_by: ["M2-00", "M2-01", "M2-02", "M2-03", "M2-04", "M2-05", "M2-06", "M2-07", "M2-08", "M2-09"]
estimate: "1h"
resources: []
needs: ["P-03", "P-04", "P-05", "P-06"]
---

## Context

M2 delivers the core loop (R1, R3, R5, R6) and the first half of the demo arc (R4). The gate checks, from a clean state, that the claims M2 makes are shown by tests, evals and a recorded run rather than by tickets being closed. It is run with `/gate 2`, never spawned by `/start-milestone`.

## Scope

1. Fresh clone / clean checkout, `make down && make up`, migrations from scratch, then `./scripts/landing-checks.sh` at full level.
2. Integration tests of the milestone: upload fuzz, extraction, evidence rules, RFI ingest and concurrency, approvals (replay, TOCTOU, kill switch, UNKNOWN resolution), answer memory, hold screen.
3. Evals on fixtures: extraction (wrong-but-verified 0, quote mutation detected 100%) and verifier (mutation rejection 100%, grounded drafts accepted 100%).
4. Deployed e2e evidence present: `docs/evidence/m2-run.md` with an ANSWERED RFI and CONFIRMED attempt, screenshots, replay e2e green.
5. Plan check (`python3 scripts/check-plan.py`) and prerequisites (`python3 scripts/check-prereqs.py`) still pass for M3.
6. Then the non-blocking backlog sweep per `/gate`.

## Out of scope

- Fixing failures (open or reopen the owning ticket; the gate only reports)
- Live API calls (the live proof is M2-09's; the gate verifies its record and replays)

## Acceptance Criteria

- [ ] Clean-state build, typecheck, lint, unit and integration tests all pass
- [ ] `./scripts/landing-checks.sh` passes at full level
- [ ] Extraction eval: `wrong_but_verified == 0`, quote-mutation detection 100%
- [ ] Verifier eval: at least 200 mutants, 100% rejected; grounded rate at least 95% on the dataset
- [ ] Invariant tests pass: no RFI event changes a money status; one open RFI per type under concurrency; approval single use
- [ ] `docs/evidence/m2-run.md` exists, shows the full step sequence through the transfer reaching SENT/PAID on its own status, and the replay e2e passes without network
- [ ] No tracked file contains a secret; no tracked file cites `docs/research/` or `.kickoff-state.md`
- [ ] Every M2 ticket's issue has its handoff comment

## Deliverables

- Gate report as a comment on the M2-GATE issue (pass/fail per criterion, command output summaries, links to the evidence files)

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; T="$(mktemp -d "$TMPDIR/m2-gate.XXXXXX")"
make down && make up
npm ci
npm run db:migrate
./scripts/landing-checks.sh
npm run test --workspaces --if-present
npm run eval -w packages/agent -- extraction --replay --out "$T/ex.json"
jq -e '.wrong_but_verified == 0 and .mutation_detected == 1' "$T/ex.json"
npm run eval -w packages/agent -- verifier-mutation --out "$T/ver.json"
jq -e '.mutants >= 200 and .rejected == .mutants and .good_accepted == .good_total' "$T/ver.json"
npm run test -w apps/web -- rfi-concurrency approval-replay rfi-invariant-no-money-status
E2E_MODE=replay npx playwright test apps/web/e2e/core-demo.replay.spec.ts
grep -q "ANSWERED" docs/evidence/m2-run.md && grep -q "CONFIRMED" docs/evidence/m2-run.md
! git ls-files | xargs grep -lE "docs/research/|\.kickoff-state\.md" 2>/dev/null
python3 scripts/check-plan.py
python3 scripts/check-prereqs.py || true
./scripts/check-no-secrets.sh
```

## Handoff → M3 tickets

M3 starts only when this gate is green. Post the gate report on the M2-GATE issue with the eval numbers and the measured SLO values from `docs/evidence/m2-run.md`; list any backlog entries from the sweep.
