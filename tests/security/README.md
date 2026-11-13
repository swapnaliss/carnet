# Security tests: STRIDE row to test map

Every row of the STRIDE table in `docs/architecture.md` §8 maps to at least one named test below.
`python3 scripts/check-stride-map.py` fails if a row has no entry, if a listed file is missing, or if
the named test text is not in that file. Entries read `file :: text that appears in the test name`.

Run the suites here with `npx vitest run tests/security` (no database). The database-backed tests
listed below run in the `db` and `web-db` projects of the root `vitest.config.ts`.

## Spoofing · Forged Airwallex webhook
- tests/security/webhook-verify.test.ts :: rejects a forged signature
- tests/security/webhook-verify.test.ts :: rejects a timestamp more than 5 minutes old
- tests/security/webhook-verify.test.ts :: rejects a future-dated timestamp
- apps/web/test/webhooks/route.int.test.ts :: 5 posts of the same event, sequential and concurrent, leave one event and one job
- apps/web/test/webhooks/route.int.test.ts :: a tampered body returns 401 and stores nothing

## Spoofing · Stolen session
- apps/web/test/security/login-ratelimit.int.test.ts :: 20 concurrent wrong-password attempts
- apps/web/test/auth/authz.test.ts :: unauthenticated gets 401

## Tampering · Changing an answer between approval and submit
- apps/web/test/approval-toctou.int.test.ts :: a newer updated_at: refused RFI_UPDATED
- apps/web/test/approval-replay.int.test.ts :: 20 concurrent executors for one approval: exactly one CONSUMED row

## Tampering · Editing audit history
- packages/db/test/audit-chain.test.ts :: a modified row is HASH_MISMATCH at that row
- packages/db/test/audit-roles.test.ts :: TRUNCATE

## Repudiation · "I never approved that"
- packages/db/test/approvals.int.test.ts :: stores an APPROVED approval with the shown snapshot

## Information disclosure · Payee page reveals a compliance hold
- apps/web/test/payee/payee-status.int.test.ts :: a live link answers 200 with the privacy headers and no cookie
- apps/web/test/payee/payee-status.int.test.ts :: a limited caller answers 429 with the same headers and retry-after

## Information disclosure · Prompt injection exfiltrates data
- packages/agent/test/guardrail.test.ts :: puts text in one delimited block that the content cannot close or reopen
- packages/agent/test/drafting/drafting.test.ts :: a poisoned question and a model that obeys it: flags are stored and the claim is rejected
- packages/agent/test/boundaries.test.ts :: the API key is read in exactly one module
- tests/security/hostile-model.test.ts :: markdown exfiltration link
- tests/security/hostile-model.test.ts :: leaves ordinary text alone

## Denial of service · Webhook flood, upload abuse
- apps/web/test/security/webhook-ratelimit.int.test.ts :: 601 requests from one IP within a minute
- apps/web/tests/fuzz/documents.fuzz.test.ts :: never 5xx, and stores a row only for a 200/201
- tests/security/upload-filenames.test.ts :: becomes a safe name of at most 50 characters ending .pdf

## Elevation of privilege · Cross-tenant access
- apps/web/test/security/cross-tenant.int.test.ts :: reads: own id 200; another business's id 404
- packages/db/test/tenancy.int.test.ts :: has a cross-tenant case

## Elevation of privilege · Prompt-injected plan action
- packages/agent/test/boundaries.test.ts :: imports no web framework
- apps/web/test/security/approval-routes.int.test.ts :: an answer that needs the owner is refused (412)
- tests/security/hostile-model.test.ts :: tool-call lookalike

## Not yet covered by a named test (tracked on the M4-04 issue and BL-01)
Hostile stub model over document text (only RFI question text is covered), the 21-page and encrypted-PDF cases through the live route, payee token entropy, cookie flags, and the
kill-switch/spend-cap row (M4-02, PR #102). These are not claimed by this map.
