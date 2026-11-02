---
title: "M4-GATE · Milestone gate"
milestone: "M4 · Governance & Evals"
labels: ["gate"]
blocked_by: ["M4-01", "M4-02", "M4-03", "M4-04", "M4-05", "M4-06", "M4-07"]
estimate: "1h"
resources: []
needs: ["P-04", "P-05"]
---

## Context

M4 makes Carnet's trust claims checkable: an audit chain that detects tampering, a kill switch with defined in-flight semantics, an eval suite whose numbers go into the README, security tests for the STRIDE table, a labelled replay for judges, measured scaling numbers and an accessibility and Web Vitals pass (R3, R5, R6, R8, R9). The gate proves all of it from a clean state before M5 writes any claims. `/gate 4` runs this ticket; it is never spawned by `/start-milestone`.

## Scope

1. Start from a clean state: fresh clone or `git status` clean on `main`, `docker compose down -v`, fresh install, migrations on a new database.
2. Run `./scripts/landing-checks.sh` at the full level.
3. Verify the evidence files exist, are tracked, were generated at or after the commit of the last M4 code change, and meet thresholds: `docs/evidence/evals.md` (mutation rejection 100%, grounding >= 95%, at least 40 ground-truth cases), `docs/evidence/load-test.md`, `docs/evidence/a11y-cwv.md`.
4. Run the security suite and scans (`tests/security`, `npm audit`, `gitleaks`).
5. Run the audit-chain, kill-switch, replay and demo-reset tests once more.
6. Run `python3 scripts/check-plan.py` and `python3 scripts/check-prereqs.py`, then the non-blocking backlog sweep per `/gate`.
7. Every M4 ticket issue is closed with its handoff comment posted.

## Out of scope

- Fixing failures (open or reopen the owning ticket; the gate only reports).
- README, video or submission content (M5).

## Acceptance Criteria

- [ ] Clean state and fresh install: build, migrations and `./scripts/landing-checks.sh` pass
- [ ] `docs/evidence/evals.md` present with mutation-rejection rate 100%, grounding rate >= 95%, >= 40 cases, and run date after the last change to prompts, schemas or the verifier
- [ ] Security tests green; `npm audit --omit=dev --audit-level=high` and `gitleaks` clean
- [ ] Audit chain verification OK and tamper tests green; kill-switch and spend-cap tests green
- [ ] Judge replay, session caps and demo reset tests green; `npm run demo:reset -- --yes` is idempotent
- [ ] `docs/evidence/load-test.md` and `docs/evidence/a11y-cwv.md` present and tracked, a11y/CWV from the hosted app (or the gate records why not)
- [ ] All M4 issues closed with handoff comments; backlog sweep run

## Deliverables

- Gate report as a comment on the M4-GATE issue (pass or fail per criterion, with the commands run)
- No code changes

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"
test -z "$(git status --porcelain)"
docker compose down -v && docker compose up -d db
npm ci
npm run db:migrate
./scripts/landing-checks.sh
for f in docs/evidence/evals.md docs/evidence/load-test.md docs/evidence/a11y-cwv.md; do
  test -f "$f" && git ls-files --error-unmatch "$f" >/dev/null
done
grep -E "mutation rejection: 100(\.0+)?%" docs/evidence/evals.md
python3 - <<'PY'
import re,sys
t=open("docs/evidence/evals.md").read()
g=re.search(r"grounding rate: ([0-9.]+)%",t); c=re.search(r"cases: ([0-9]+)",t)
assert g and float(g.group(1))>=95, "grounding below 95"
assert c and int(c.group(1))>=40, "fewer than 40 cases"
PY
npm run eval -- --mode replay --out "$TMPDIR/gate-evals.md"
npx vitest run tests/security packages/db/test/audit-chain.test.ts packages/db/test/audit-roles.test.ts packages/agent/test/killswitch.test.ts packages/agent/test/spend-caps.test.ts
npm audit --omit=dev --audit-level=high
gitleaks detect --no-banner --redact --report-path "$TMPDIR/gate-gitleaks.json"
npm run demo:reset -- --yes && npm run demo:reset -- --yes
npx playwright test apps/web/e2e/replay.spec.ts apps/web/e2e/ops-audit.spec.ts apps/web/e2e/ops-killswitch.spec.ts apps/web/e2e/a11y
python3 scripts/check-plan.py
python3 scripts/check-prereqs.py
```

## Handoff → M5-01, M5-02

Comment on the M4-GATE issue: pass/fail per criterion, the numbers from the three evidence files (mutation-rejection rate, extraction accuracy, grounding, ack p95, CWV medians, axe result), and the backlog sweep result. M5-01 and M5-02 may state only these numbers, taken from the evidence files.
