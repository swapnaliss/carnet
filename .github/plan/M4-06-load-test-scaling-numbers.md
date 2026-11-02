---
title: "M4-06 · Load test proving scaling numbers"
milestone: "M4 · Governance & Evals"
labels: ["infra"]
blocked_by: ["M3-GATE"]
estimate: "4h"
resources: []
needs: []
---

## Context

`docs/architecture.md` §12 claims 0.17 requests/s average, about 2/s at a 10x peak, and about 5 KB of relational rows per payment (about 25 MB/day, about 9 GB/year at 100x). §9 sets the SLO "webhook acknowledged p95 < 300 ms warm". Claims discipline (`CLAUDE.md`): README and deck claim only what a test shows. Judges for a system-design rubric will ask whether the numbers were measured. This ticket measures them and corrects the architecture text if they are wrong.

## Scope

1. **Tool choice.** Choose the simplest tool and justify it in the results file. Default plan: a small Node script (Node 24 global `fetch`, `node:crypto` for HMAC signing) because it needs no install, can sign valid webhook payloads with the same helper the tests use, and runs on any machine; consider k6 only if it is already installed and clearly simpler. If k6 is chosen, verify the installed version that day (`k6 version`) and record it; do not install anything in this ticket. Record the Node version used.
2. **Workload.** Replays recorded webhook events (fixtures from M0-05, M1-05, M2-04, M3-07: transfer status events and `rfi.*` events) signed with a throwaway local webhook secret against a local stack (`docker compose`: web, worker, Postgres). Profiles at the architecture rates: average 0.17/s, peak 2/s, burst 20/s (the sandbox limit), each for a fixed duration with arrival times open-loop (not waiting for responses). Includes duplicate deliveries (about 10%) and out-of-order events, as in production.
3. **Measurements:** webhook ack latency p50/p95/p99 and error rate; job latency from `webhook_events.received_at` to `outbox_jobs` completion (p50/p95/p99, from DB timestamps); queue depth over time and drain time after the burst; worker CPU and memory (`docker stats`); `SKIP LOCKED` behaviour with 1 and 3 worker instances (no job processed twice, asserted from DB).
4. **Storage growth:** create N synthetic payments through the real code paths (including events, jobs, audit rows, drafts excluded from documents), measure relational bytes per payment via `pg_total_relation_size` deltas, excluding the `documents.bytes` column (documents measured separately), and compare with the 5 KB figure and the 25 MB/day, 9 GB/year extrapolations.
5. **Results file** `docs/evidence/load-test.md` (tracked): environment (machine class, versions, commit), method, raw summary tables, whether each number in architecture §12 and the §9 SLO is confirmed or corrected, and caveats (local stack, not the hosted environment; Airwallex calls replayed from fixtures, so only our side is measured). If a number is wrong, edit `docs/architecture.md` §12 in this PR to the measured value with a pointer to the file.
6. No Airwallex calls and no model calls: the worker uses the recorded-response adapter used by integration tests.

## Out of scope

- Load testing the hosted environment or the Airwallex sandbox (rate limits, shared account).
- Soak tests longer than the profile durations.
- Performance tuning beyond fixing a defect that makes the SLO fail (log larger work to `BL-01`).
- Browser performance (M4-07).

## Acceptance Criteria

- [ ] `npm run load` runs the three profiles against the local stack and writes machine-readable results to `$TMPDIR` and a table to the console; it exits non-zero when a configured SLO is breached
- [ ] Results show webhook ack p95 for average, peak and burst profiles, and job latency p50/p95/p99, with duplicates deduplicated (no duplicate effects, asserted from DB)
- [ ] With 3 worker instances no job runs twice and the queue drains after the burst; drain time is recorded
- [ ] Bytes per payment row is measured and compared with 5 KB; documents measured separately; extrapolations to 100x recomputed
- [ ] `docs/evidence/load-test.md` exists with tool choice and version justification, method, results and a confirm/correct verdict for each architecture §12 figure and the §9 ack SLO; `docs/architecture.md` matches the measurements
- [ ] No secret appears in the results or script (webhook secret is generated per run)
- [ ] `./scripts/landing-checks.sh` passes

## Deliverables

- `scripts/load/` (generator, profiles, DB probes), `npm run load`
- `docs/evidence/load-test.md`
- Edits to `docs/architecture.md` §12 only if measurements differ

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"
docker compose up -d db web worker
npm run db:migrate
node --version
npm run load -- --profile all --out "$TMPDIR/load.json"
node -e 'const r=require(process.argv[1]); if(!(r.burst.ackP95Ms<300)) {console.error("ack p95 over SLO"); process.exit(1)}' "$TMPDIR/load.json"
npm run load -- --check-duplicates
test -f docs/evidence/load-test.md
grep -E "bytes per payment" docs/evidence/load-test.md
./scripts/landing-checks.sh
```

## Handoff → M4-GATE, M5-01

Comment on the issue: the measured ack p95/p99 per profile, job latency, bytes per payment, and which architecture numbers were confirmed or corrected. The gate checks the evidence file; M5-01 quotes scaling numbers only from `docs/evidence/load-test.md`.
