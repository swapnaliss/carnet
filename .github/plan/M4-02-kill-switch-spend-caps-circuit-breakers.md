---
title: "M4-02 · Kill switch, spend caps, DB circuit breakers, in-flight semantics"
milestone: "M4 · Governance & Evals"
labels: ["agent", "security"]
blocked_by: ["M3-GATE"]
estimate: "5h"
resources: []
needs: []
---

## Context

R5 and R6 ("code enforces, model judges", typed tools, bound approvals) need a governance layer the owner can use under stress. `docs/architecture.md` §10 requires a kill switch (`agents_enabled`, `execution_enabled`), per-run and daily spend caps in `system_flags`, and circuit-breaker state derived from recent job failures in the database, not process memory (§9). Risk register: "Anthropic rate limits" and credit drain from a $100 grant. Money safety rule from the brief: the kill switch stops new model calls and executions and invalidates pending approvals, while in-flight attempts continue to resolution so no `UNKNOWN` attempt is abandoned ([ADR 0007](../../docs/adr/0007-execution-attempts-and-unknown-outcomes.md), [ADR 0009](../../docs/adr/0009-deterministic-workflow-no-money-tools.md)).

## Scope

1. **Flags.** `system_flags` holds `agents_enabled`, `execution_enabled`, `daily_spend_cap`, `per_run_cap` (columns from `docs/architecture.md` §5); defaults seeded from `MODEL_PER_RUN_CAP_USD` and `MODEL_DAILY_SPEND_CAP_USD`. One reader module (`packages/db` or `packages/agent`) is the only way code reads them, with a fresh DB read at each decision point (no caching beyond the request).
2. **Toggle.** Owner-only UI control on `/ops` and an API route (`POST /api/ops/flags`, owner role enforced server-side, CSRF-safe, zod-validated). Every change writes an audit entry through M4-01's `appendAudit` with actor, old and new value, and optional reason. Builds to `docs/design/`; the control states clearly what each switch does and shows current state.
3. **Semantics, each enforced in code:**
   - `agents_enabled = false`: no new model call starts (the agent harness refuses before the API request and records a `KILLED` step); an RFI that arrives meanwhile is ingested and routed to `NEEDS_OWNER` so the owner can write the answer, per the degradation rule in architecture §9.
   - `execution_enabled = false`: no new `ExecutionAttempt` of any kind (transfer, conversion, respond) is created; auto-approved FX conversions do not run; the plan UI says execution is paused.
   - Pending approvals become invalid while off: the approval-consume path refuses with a distinct reason, and on re-enable they remain invalid (the owner re-approves against current state). Approvals are marked `REVOKED_BY_KILL_SWITCH`, not deleted.
   - In-flight attempts (`INTENT`, `SENT_TO_AIRWALLEX`, `UNKNOWN`) continue to resolution by the reconciler even when both flags are off; the reconciler only looks up, never creates, so it is not blocked by the switch.
4. **Spend caps.** Per-run cap and daily cap enforced before each model call using worst-case estimated cost (input tokens counted, `max_tokens` bound) and after each call with actual usage; a breach stops the run with `SPEND_CAP` and degrades drafting to `NEEDS_OWNER`. Current day spend, per-run spend and the caps are shown on `/ops`. Day boundary is UTC and documented.
5. **Circuit breakers from the DB.** Breaker state (`CLOSED`, `OPEN`, `HALF_OPEN`) is a pure function of recent `outbox_jobs` and `agent_steps` failures per dependency (Airwallex, model) within a window; thresholds and window are config values with defaults; `OPEN` pauses new calls to that dependency (jobs get `run_after` pushed with jittered backoff) and shows on `/ops`. No in-memory counter decides anything; two worker instances agree.
6. A short operator note in `docs/` (existing runbook file if M1-09 created one, otherwise a section in `docs/architecture.md` §9) on when to flip each switch.

## Out of scope

- Per-agent or per-business switches (one global business in the demo; per-agent scoping is future vision).
- Changing what the planner does (it keeps running; it is pure code).
- Alerting integrations beyond the `/ops` page and the existing health check.
- Model-side retries tuning beyond the breaker (SDK backoff stays).

## Acceptance Criteria

- [ ] Test: with `agents_enabled = false`, starting a draft, extraction or criticality run makes zero outbound model requests (fetch spy / SDK stub asserts 0 calls) and records `KILLED`
- [ ] Test: with `execution_enabled = false`, an approved action does not create an `ExecutionAttempt` and no Airwallex write call is made; auto-FX does not execute
- [ ] Test: approvals that were `APPROVED` before the switch cannot be consumed while off and are `REVOKED_BY_KILL_SWITCH`; after re-enable consuming them still fails and a fresh approval works
- [ ] Test: an attempt in `UNKNOWN` and one in `SENT_TO_AIRWALLEX` are resolved by the reconciler while both flags are off (fixture lookup returns the transfer; attempt becomes `CONFIRMED`)
- [ ] Test: per-run cap stops a multi-call run at the cap with `SPEND_CAP`; daily cap blocks the next run; a rolled-over UTC day allows it again; spend figures match `agent_runs.cost`
- [ ] Test: the breaker opens after N failures inside the window, half-opens after the cool-down and closes after a success, derived only from DB rows (test runs two independent reader instances and they agree; no module-level mutable state, asserted by a lint/grep test)
- [ ] Non-owner call to the toggle API is rejected (403) and writes no audit entry; owner toggle writes one entry that `verifyAuditChain` accepts
- [ ] Playwright: the owner toggles both switches on `/ops` and sees state and spend; keyboard-operable; design review passes
- [ ] `./scripts/landing-checks.sh` passes

## Deliverables

- `packages/db` flags reader and migration changes if columns are missing; `packages/agent` guard in the harness; executor guard; reconciler exemption
- Breaker module and tests; `/ops` panel, `POST /api/ops/flags`
- Tests under `packages/agent/test/`, `packages/db/test/`, `apps/web/e2e/ops-killswitch.spec.ts`
- Operator note (see Scope 6)

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"
docker compose up -d db
npm run db:migrate
npx vitest run packages/agent/test/killswitch.test.ts packages/agent/test/spend-caps.test.ts packages/db/test/breaker.test.ts packages/db/test/inflight-semantics.test.ts
npx playwright test apps/web/e2e/ops-killswitch.spec.ts
! grep -rnE "^(let|var) .*(failures|breaker|openUntil)" packages apps --include=*.ts --exclude-dir=node_modules --exclude-dir=test
./scripts/landing-checks.sh
```

## Handoff → M4-03, M4-04, M4-05, M4-GATE

Comment on the issue: flag names, the guard function names, how the caps are configured (`MODEL_PER_RUN_CAP_USD`, `MODEL_DAILY_SPEND_CAP_USD`) and the exact semantics tested. M4-03 reuses the spend guard for the eval CI cap; M4-04 asserts kill-switch behaviour under attack payloads; M4-05 reuses the per-run cap guard for per-session limits; the gate re-runs the tests.
