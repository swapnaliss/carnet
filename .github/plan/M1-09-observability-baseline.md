---
title: "M1-09 · Observability baseline: pino, correlation ids, /ops SLO query"
milestone: "M1 · Walking Skeleton"
labels: ["infra"]
blocked_by: ["M1-05"]
estimate: "4h"
resources: []
needs: []
---

## Context

ADR 0015: pino JSON logs to stdout with correlation ids (request, event, RFI, run), SLOs computed from
database timestamps on `/ops`, and an optional scheduled GitHub Actions health check. Platform log
retention is unknown, so the DB summaries matter. SLOs from `docs/architecture.md` §9 that this
ticket can compute now: webhook acknowledged p95 < 300 ms warm, and job latency. The `agent_runs` and
`agent_steps` tables belong to M2-00 and are not created here; the `/ops` page leaves a clearly
labelled slot for them and the audit chain check (M4-01).

## Scope

1. **Logging**: pino 10.4.0 JSON logger in a shared module with redaction of `authorization`,
   cookies, `password`, API key and secret fields, and identifiers redacted per the PII rule;
   level from `LOG_LEVEL`.
2. **Correlation ids**: middleware assigns `request_id` (honours an inbound `x-request-id` only if it
   matches a safe pattern), stored in `AsyncLocalStorage`; webhook handling adds `event_id`; worker
   jobs carry `job_id`, `event_id`, `rfi_id` and (later) `run_id`; the id is returned in the
   `x-request-id` response header and in the shared error format's `request_id`.
3. **Timestamps for SLOs**: ensure `webhook_events.received_at` and an `acked_at` (set at commit of
   the inbox transaction), and `outbox_jobs` `created_at`, `locked_at`, `finished_at` exist (small
   additive migration if M1-02 lacked a column).
4. **`/ops` page** (owner and approver roles; server component) computing from the DB: webhook ack
   latency p50/p95 over the last 24 h, job queue latency (created to locked) and processing time,
   queue depth, count of DEAD jobs, last worker heartbeat age, last reconcile run, count of
   incidents (PAID to FAILED), `UNKNOWN` attempts count. Each metric shows its definition, window and
   sample size and says "no data" instead of zero when empty. Built to `docs/design/screens/ops.md`
   and the M1-07 tokens. The ticket has no `frontend` label because the page only composes existing
   shell components; if it adds a new visual component, add the label and run the `ui-reviewer`
   (builds to `docs/design/`).
5. **Scheduled check**: `.github/workflows/health.yml` (cron every 15 min, `workflow_dispatch`) that
   curls `/healthz` and a token-protected JSON summary of the SLO query (`/api/ops/slo`, readable
   only with a header secret from `OPS_CHECK_TOKEN`) and fails the run on a breach. Optional: the
   workflow is skipped when the repository variable for the deployed URL is unset.

## Out of scope

- LLM/agent run metrics and spend (M2-00, M4-02), audit chain verification (M4-01), tracing services
- Dashboards beyond `/ops`

## Acceptance Criteria

- [ ] Every log line from web and worker is valid JSON with `time`, `level`, `msg`, `request_id` or `job_id`; a test parses all captured output
- [ ] Redaction test: logging an object with `password`, `authorization`, `apiKey` fields emits `[Redacted]` for each
- [ ] A request carrying a valid `x-request-id` echoes it; a malformed one is replaced; the same id appears in the log line, the response header and an error body
- [ ] Posting a fixture webhook produces log lines sharing one `event_id` across the route and the worker handler (test joins them)
- [ ] SLO query unit/integration test: with seeded `webhook_events` of known latencies, p95 computed equals the expected value; with an empty table the page and endpoint report "no data"
- [ ] `/ops` returns 403 for the viewer role and 200 for owner; renders without client JS errors (Playwright)
- [ ] `/api/ops/slo` without the header token returns 401; with it returns the JSON summary
- [ ] The workflow file passes `actionlint` (or a YAML parse check) and contains no secret values (secrets referenced by name only)
- [ ] `npm run test` for affected workspaces exits 0

## Deliverables

- `apps/web/src/lib/{logger,request-context}.ts`, `apps/web/src/middleware.ts` (or route wrapper)
- `packages/db/src/queries/slo.ts`, migration for any added timestamp columns
- `apps/web/src/app/ops/page.tsx`, `apps/web/src/app/api/ops/slo/route.ts`
- `.github/workflows/health.yml`
- Tests: `apps/web/test/observability/*.test.ts`, `packages/db/test/slo.test.ts`
- `.env.example` entries (keys only): `LOG_LEVEL`, `OPS_CHECK_TOKEN`

## Validation Gate

```bash
set -euo pipefail
docker compose up -d postgres
npm run db:migrate -w packages/db
npm run test -w packages/db -- slo
npm run test -w apps/web -- observability
npm run typecheck -w apps/web
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/health.yml'))"
! grep -rEn "console\.log" apps/web/src packages/*/src
./scripts/check-no-secrets.sh
```

## Handoff

M2-00 (logger and correlation module, `run_id`), M4-01 (chain check slot on `/ops`), M4-06 (load test
reads these queries), M1-GATE. Comment on the issue: logger import path, the correlation fields, the
SLO definitions with windows, and how to read `/ops`.
