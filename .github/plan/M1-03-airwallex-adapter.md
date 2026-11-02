---
title: "M1-03 · Airwallex adapter (auth cache, transfers, beneficiaries, balances, FX, RFI, files, simulation port) + contract tests on fixtures"
milestone: "M1 · Walking Skeleton"
labels: ["backend"]
blocked_by: ["M0-GATE"]
estimate: "8h"
resources: []
needs: []
---

## Context

R0 (uses Airwallex APIs, mandatory) and R7 (simulation behind one interface). The official SDK is Beta
and stale, so ADR-aligned raw REST with typed wrappers is used. ADR 0007 requires lookup by
`request_id` and never minting a new id for the same intent; ADR 0018 requires a `SandboxSimulator`
port that calls only real `/simulation/*` endpoints; `docs/architecture.md` §6/§9 require 10 s
timeouts, jittered retries honouring 429, and HMAC verification over the raw body. Facts come from
`docs/evidence/airwallex-rfi-contract.md` and the M0-03/M0-04/M0-05 fixtures in
`fixtures/airwallex/`; where a fixture contradicts the contract file, the fixture wins and the
contract file is updated in the same PR.

## Scope

New workspace `packages/airwallex` (depends on `packages/domain`; no other internal dependency):

1. **HTTP core**: `fetch` with a 10 s `AbortController` timeout, retry with exponential backoff and
   full jitter on 429/502/503/504 and network errors, honouring `retry-after`; no retry of a
   non-idempotent POST without a `request_id`; typed error classes (`AirwallexApiError` with code,
   `AirwallexTimeout`, `AirwallexRateLimited`). `x-api-version` handling per the fixtures; the FX
   calls omit it (CLAUDE.md).
2. **Token cache**: login with `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY`, token cached in memory
   and refreshed at 25 minutes (lifetime is 30); single-flight refresh; one forced re-login on 401.
3. **Typed wrappers** (zod-validated responses, mapped to domain types): beneficiaries (create,
   retrieve), transfers (create with `request_id`, retrieve, list/lookup by `request_id`), balances
   (current), FX (quote, conversion create, retrieve), RFIs (list, retrieve, respond), files upload
   (multipart to the files host, filename at most 50 characters, PDF or JPEG only).
4. **`SandboxSimulator` port** (interface in `packages/airwallex/src/simulator.ts`) with an
   implementation calling only real endpoints: RFI create, follow_up, close, transfer transition,
   plus whatever funding endpoint M0-03 proved. A test fails if the implementation references any
   path not starting with `/simulation/`.
5. **Webhook signature verification**: `verifyWebhook({ rawBody, timestamp, signature, secret, now })`:
   HMAC-SHA256 over `timestamp + rawBody`, hex, `crypto.timingSafeEqual`, rejects timestamps older
   than 5 minutes (and more than 1 minute in the future), rejects malformed hex without throwing a
   timing-different error.
6. **Contract tests** that replay the recorded fixtures through a local fetch stub (no network):
   each wrapper parses the real recorded body for its endpoint.

## Out of scope

- Any database access, outbox or webhook route (M1-05), attempt persistence (M1-08, M2-07)
- Live calls in tests (live proof happens in M1-08)
- Using `@airwallex/node-sdk`

## Acceptance Criteria

- [ ] Contract tests replay every fixture under `fixtures/airwallex/` that corresponds to a wrapper and pass; `npm run test -w packages/airwallex` makes zero network calls (test sets a global fetch guard that throws on an unstubbed call)
- [ ] Timeout: a stubbed endpoint that never answers rejects with `AirwallexTimeout` at about 10 s (fake timers)
- [ ] Retry: a stub returning 429 with `retry-after` then 200 succeeds and waited at least the header value; 5xx exhaustion raises the typed error after the configured attempts; backoff delays differ across runs (jitter) within bounds
- [ ] A POST transfer that times out is not retried with a new `request_id`; the wrapper exposes `findTransferByRequestId` and the test shows it is used for lookup
- [ ] Token cache: two concurrent calls trigger one login; the token is refreshed after 25 minutes (fake clock) and not before; a 401 triggers exactly one re-login
- [ ] Webhook verify: accepts a fixture-derived valid signature; rejects tampered body, wrong secret, 6-minute-old timestamp, future timestamp, odd-length hex; uses `timingSafeEqual` (grep test)
- [ ] The simulator implementation only calls `/simulation/*` paths (static test)
- [ ] No secret value appears in any log or error message (test: error `toString()` and logger output for a failed login contain neither the key nor the token)
- [ ] `npm run typecheck -w packages/airwallex` exits 0

## Deliverables

- `packages/airwallex/src/{http,auth,transfers,beneficiaries,balances,fx,rfis,files,simulator,webhook,index}.ts`
- `packages/airwallex/test/*.contract.test.ts` and `packages/airwallex/test/fixture-loader.ts`
- `.env.example` entries (keys only): `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY`, `AIRWALLEX_BASE_URL`, `AIRWALLEX_FILES_URL`, `AIRWALLEX_WEBHOOK_SECRET`
- Updated `docs/evidence/airwallex-rfi-contract.md` only if a fixture contradicts it

## Validation Gate

```bash
set -euo pipefail
npm run typecheck -w packages/airwallex
npm run test -w packages/airwallex
npx biome check packages/airwallex
# no SDK, no stray paths
! grep -rn "@airwallex/node-sdk" package.json packages/*/package.json
! grep -rEn "[\"'\`]/api/v1/(?!simulation)" packages/airwallex/src/simulator.ts || true
grep -c "timingSafeEqual" packages/airwallex/src/webhook.ts
./scripts/check-no-secrets.sh
```

## Handoff

M1-05 (handlers call `getTransfer`, `getRfi`, `listRfis`, `verifyWebhook`), M1-08 (create beneficiary,
transfer, simulator), M2-04, M2-07 (respond, files), M3-03. Comment on the issue: the exported
function list with the fixture each is tested against, the env key names, and any place where the
recorded behaviour differed from the contract file.
