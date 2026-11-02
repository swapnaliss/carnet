---
title: "M1-05 · Webhook inbox (HMAC, dedupe) + worker loop + outbox (SKIP LOCKED) + reconcile skeleton"
milestone: "M1 · Walking Skeleton"
labels: ["backend", "infra"]
blocked_by: ["M1-02", "M1-03"]
estimate: "6h"
resources: []
needs: ["P-02"]
---

## Context

ADR 0005 (outbox jobs, a worker process, a reconcile poll) and ADR 0006 (payment status as a
projection; stale events ignored). Airwallex webhooks are at-least-once and unordered, so the route
must acknowledge fast and the worker must fetch the object rather than trust the payload. Supports
R0 and the SLO "webhook acknowledged p95 < 300 ms warm" (`docs/architecture.md` §9); mitigates the
risk "Timeouts or crashes around money calls" through the reconcile skeleton for ADR 0007. The
kill-switch flag (`system_flags.execution_enabled`) is read before executing (full semantics: M4-02).

## Scope

1. **Route** `POST /api/webhooks/airwallex`: read the raw body (no JSON parse before verification),
   `verifyWebhook` from M1-03 (HMAC over `x-timestamp + rawBody`, constant-time, 5-minute freshness),
   then in ONE transaction insert `webhook_events` (unique `provider_event_id`; a duplicate is a
   no-op) and an `outbox_jobs` row, and return 200. Invalid signature returns 401 and stores nothing
   but is counted in a log line. No slow work in the request.
2. **Worker mode** (`PROCESS_MODE=worker` entry in `apps/web` or a `worker` package entry shared by
   the same image): claims jobs with `SELECT ... FOR UPDATE SKIP LOCKED` every 1 s, executes the
   handler, marks DONE; on failure retries with exponential backoff and jitter (`run_after`), marks
   `DEAD` after the retry limit (config, default 8); graceful shutdown on SIGTERM; liveness
   heartbeat log line every 30 s.
3. **Handlers** (plain functions, idempotent): for `payout.transfer.*` events fetch the transfer
   with the adapter and call `applyTransferUpdate` (M1-01) so a payload older than the stored
   `transfer_updated_at` or rank is ignored; for `rfi.*` events fetch the RFI and store a minimal
   record only if M2-04 has not landed (otherwise a logged no-op placeholder handler registered under
   the same job kind). The payload status is never trusted.
4. **Reconcile job** every 60 s (enqueued by the worker loop itself, one at a time): polls
   `GET /rfis` (open statuses) and open transfers (non-final payments), applies them through the same
   handlers, and has a skeleton step that resolves `execution_attempts` in `UNKNOWN` by looking the
   object up by `request_id` (transfer) and marking `CONFIRMED` or `REJECTED`; a missing object after
   the lookup stays `UNKNOWN` with an alert log line (never a new request).
5. **Kill switch read**: executing handlers (any that would call a mutating Airwallex endpoint) read
   `system_flags.execution_enabled` first and defer the job when false. Read-only fetch handlers still
   run.

## Out of scope

- RFI state machine and orphan queue (M2-04), respond executor (M2-07), circuit breakers (M4-02)
- Correlation-id middleware and SLO page (M1-09), rate limiting of the route (M1-10 adds it)
- Live webhook subscription (M0-05 did the spike; M1-08 proves it in production)

## Acceptance Criteria

- [ ] Replaying the recorded webhook fixtures from M0-05 into the route (signed with a test secret) returns 200 and creates one `webhook_events` row and one `outbox_jobs` row per distinct event id
- [ ] Posting the same event 5 times (including concurrently) leaves exactly one event row and one job; every response is 200
- [ ] Tampered body, wrong secret, and a 6-minute-old timestamp return 401 and insert nothing
- [ ] Two worker loops started on the same database never process the same job twice (test with 200 jobs; every job's side-effect counter is exactly 1)
- [ ] A handler that throws is retried with increasing `run_after`, and becomes `DEAD` after the limit (limit reduced in the test); the last error is stored
- [ ] Out-of-order test: feed fixture events for one transfer in all permutations of 4 events; the stored `transfer_status` and `transfer_updated_at` equal the in-order result; the handler fetches the (stubbed, fixture-backed) resource and ignores the payload's status
- [ ] A `PAID` then `FAILED` sequence produces an incident record/log marker
- [ ] RFI events never change `payments.transfer_status` (test)
- [ ] Reconcile: a payment whose webhook was never delivered is brought to the fetched status within one reconcile pass; an `UNKNOWN` attempt whose lookup finds the transfer becomes `CONFIRMED` and no create call is made (stub counts zero POSTs)
- [ ] With `execution_enabled=false` a mutating job is deferred, a fetch job still runs
- [ ] Worker handles SIGTERM by finishing the in-flight job then exiting 0 (test)
- [ ] `npm run test` for the affected workspaces exits 0 against Docker Postgres

## Deliverables

- `apps/web/src/app/api/webhooks/airwallex/route.ts`
- `apps/web/src/worker/{main,loop,backoff,reconcile}.ts`, `apps/web/src/worker/handlers/{transfer,rfi}.ts`
- `packages/db/src/repos/{webhook-events,outbox,attempts}.ts` additions
- Tests: `apps/web/test/webhooks/*.test.ts`, `apps/web/test/worker/*.test.ts`
- `.env.example` entries (keys only): `PROCESS_MODE`, `WORKER_POLL_MS`, `OUTBOX_MAX_ATTEMPTS`

## Validation Gate

```bash
set -euo pipefail
docker compose up -d postgres
npm run db:migrate -w packages/db
npm run test -w apps/web -- webhooks worker
npm run typecheck -w apps/web
# the route verifies before parsing
grep -n "verifyWebhook" apps/web/src/app/api/webhooks/airwallex/route.ts
grep -rn "FOR UPDATE SKIP LOCKED" packages/db/src apps/web/src | head -1
./scripts/check-no-secrets.sh
```

## Handoff

M1-08 (end to end), M1-09 (adds correlation ids and reads job/ack timestamps), M1-10 (rate limits the
route), M2-04 and M2-07 (register handlers; attempt resolution). Comment on the issue: the job kinds,
how to register a handler, retry limit and backoff constants, and the route's exact response codes.
