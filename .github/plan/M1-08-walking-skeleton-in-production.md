---
title: "M1-08 · Walking skeleton in production: create payment (real sandbox transfer) → webhook → worker → UI status"
milestone: "M1 · Walking Skeleton"
labels: ["backend", "frontend", "critical"]
blocked_by: ["M1-04", "M1-05", "M1-06", "M1-07"]
estimate: "6h"
resources: ["AIRWALLEX_SANDBOX", "DEPLOY"]
needs: ["P-03", "P-05", "P-06", "P-10", "P-17"]
---

## Context

The thinnest end-to-end slice proves the whole architecture before features pile on: auth (ADR 0012),
database (ADR 0002), adapter (R0), persisted `ExecutionAttempt` (ADR 0007), webhook inbox and worker
(ADR 0005), projection (ADR 0006), the deployed container (ADR 0014) and the polling UI (ADR 0017,
3 s). Risks covered: webhook delivery to the stable URL, timeouts around money calls, and hosting
surprises. This is the live-proof ticket for the skeleton; it uses the beneficiary and funded wallet
steps recorded in M0-03 and only the sandbox (never production keys).

## Scope

1. **Create payment** (owner role, `POST /api/v1/payments`, zod body from `packages/domain`, money in
   the Airwallex boundary format, `Idempotency-Key` stored per ADR 0004): in ONE transaction insert the
   `payments` row and an `execution_attempts` row with a fresh `request_id` (status `INTENT`); commit;
   then call the adapter to create the transfer using that `request_id` (via an outbox job so the
   request returns fast), mark the attempt `SENT_TO_AIRWALLEX` then `CONFIRMED` with the response; on
   timeout/5xx mark `UNKNOWN` and let the reconcile skeleton (M1-05) resolve by `request_id`. The same
   `request_id` is reused for any retry; never a new one. Beneficiary: reuse the demo counterparty
   created via the M0-03 steps (created through the adapter if absent).
2. **Funding**: the demo balance is the funded sandbox wallet from M0-03; the ticket checks the
   balance before creating the payment and fails with a clear shown error when insufficient (no
   simulated funding in the product path unless M0-03 proved a real `/simulation/*` funding endpoint,
   then via the `SandboxSimulator` port).
3. **Webhook to UI**: the real `payout.transfer.*` webhooks arrive at the deployed URL, M1-05 stores
   them, the worker fetches the transfer and projects it. To progress status in the sandbox, use the
   `SandboxSimulator` transfer transition (real endpoint) from an owner-only action or the run script.
4. **UI** (composed from the M1-07 shell and tokens): payment list/detail with the status badge from
   `project()`, loading/empty/error states, 3 s polling with a live region announcing status changes,
   a "create sandbox payment" form (owner only), and a stale banner if the last successful poll is
   older than 15 s. No optimistic status.
5. **Run script** `scripts/skeleton-run.ts` (reads `DEPLOY_URL` and credentials from env key names)
   that drives the same flow headlessly and writes a JSON run log to `$TMPDIR`; used by the gate and
   for the recorded replay.
6. **Evidence**: run once against the deployed URL; save screenshots (login, create, status
   progression) under `docs/evidence/m1-skeleton/` (tracked, no secrets, no tokens in URLs), a
   redacted run log, and the recorded webhook bodies as fixtures `fixtures/airwallex/m1-skeleton/`
   for the M1-GATE replay. Post them on the issue.
7. This ticket passes the `ui-reviewer` design review and builds to `docs/design/` (M1-07).

## Out of scope

- Evidence checks, RFIs, approvals binding (M2), the plan screen, FX
- Production-grade policy limits; the payment form is a skeleton form only

## Acceptance Criteria

- [ ] Logged in on the deployed UI as the seeded owner, creating a payment results in a real sandbox transfer: the transfer id is stored and retrievable via the adapter (evidence: run log + screenshot)
- [ ] The `execution_attempts` row exists before the outbound call (commit timestamp earlier than the call timestamp in the run log) and ends `CONFIRMED`
- [ ] Simulating a timeout in an integration test (adapter stub) leaves the attempt `UNKNOWN`, and the reconcile pass resolves it with a lookup by the same `request_id` with zero additional create calls
- [ ] A real `payout.transfer.*` webhook arrives at the deployed URL, appears in `webhook_events` with `signature_ok`, and the worker updates the payment from the fetched resource
- [ ] The UI shows the new status within 6 s (two poll intervals) of the stored change, measured by the Playwright run against the deployment, and the status change is announced via a live region
- [ ] A viewer (judge) account cannot create a payment (403) but can see the list
- [ ] Idempotent create: the same `Idempotency-Key` twice yields one payment and one transfer
- [ ] Screenshots, redacted run log and recorded webhook fixtures are committed; `./scripts/check-no-secrets.sh` passes on them
- [ ] `ui-reviewer` PASS recorded on the issue
- [ ] The Airwallex sandbox rate guidance is respected (calls well under 10 concurrent)

## Deliverables

- `apps/web/src/app/api/v1/payments/route.ts`, `apps/web/src/worker/handlers/create-transfer.ts`
- `apps/web/src/app/payments/{page,[id]/page}.tsx`, components under `apps/web/src/components/payments/*`
- `scripts/skeleton-run.ts`
- `docs/evidence/m1-skeleton/*.png`, `docs/evidence/m1-skeleton/run-log.json`, `fixtures/airwallex/m1-skeleton/*.json`
- Tests: `apps/web/test/payments/*.test.ts`, `apps/web/e2e/skeleton.spec.ts`
- `.env.example`: no new keys (uses the M1-03/M1-06 keys)

## Validation Gate

```bash
set -euo pipefail
export DEPLOY_URL="${DEPLOY_URL:?deployed origin}"
curl -fsS "$DEPLOY_URL/healthz"
npm run test -w apps/web -- payments
npm run typecheck -w apps/web
# live skeleton run against the deployment (owner/session creds from env)
npx tsx scripts/skeleton-run.ts --out "$TMPDIR/skeleton-run.json"
jq -e '.transfer_id and .attempt_status=="CONFIRMED" and (.ui_status|length>0)' "$TMPDIR/skeleton-run.json"
npx playwright test apps/web/e2e/skeleton.spec.ts
test -n "$(ls docs/evidence/m1-skeleton/*.png)"
./scripts/check-no-secrets.sh
```

## Handoff

M1-GATE (replays the recorded fixtures and checks the evidence), M2-09 and M3-07 (reuse the run
script pattern). Comment on the issue: the transfer id (sandbox ids are not secrets), screenshot
paths, run-log summary with webhook-ack and status-update latencies, and any deviation found
(update `docs/evidence/airwallex-rfi-contract.md` if behaviour differed). Release `AIRWALLEX_SANDBOX`
and `DEPLOY` by posting "done".
