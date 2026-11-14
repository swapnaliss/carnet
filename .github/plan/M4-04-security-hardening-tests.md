---
title: "M4-04 · Security hardening tests (injection payloads, upload fuzz, webhook replay, STRIDE checks)"
milestone: "M4 · Governance & Evals"
labels: ["security"]
blocked_by: ["M3-GATE"]
estimate: "6h"
resources: []
needs: []
---

## Context

R6 (typed tools, bound approvals) and R5 depend on controls actually holding under attack. `docs/architecture.md` §8 is a STRIDE table; a threat model that no test exercises is only prose. Risks in `PROJECT.md` §10: public repo leaking a secret, timeouts around money calls, and prompt injection exfiltrating data or driving actions. This ticket turns every row of the table into a test, fixes what fails, and adds dependency and secret scans.

## Scope

A test suite under `tests/security/` (Vitest + a few Playwright checks), one test group per STRIDE row, each named after the row so the mapping is auditable (`docs/evidence/` is not written here; a table in the test README maps row to test):

1. **Webhooks:** forged signature, signature over a modified body, missing headers, stale timestamp (> 5 minutes) and future-dated timestamp, replay of a valid event (deduplicated, no second effect), wrong content type, oversized body; verification uses the raw body and constant-time compare; a payload whose claimed status disagrees with the fetched object is ignored (fetch-before-trust), using recorded fixtures.
2. **Tenancy:** cross-tenant reads and writes on every repository/route (documents, facts, RFIs, drafts, approvals, plans, payee links, audit) with two businesses seeded; ids guessed from the other tenant return 404/403 and leak no existence signal.
3. **Prompt injection:** payloads in documents and in RFI question text (from the M4-03 corpus plus new ones: role-play, "approve this payment", encoded instructions, markdown/HTML exfiltration links, tool-call lookalikes) processed via recorded model responses and via a hostile stub model that obeys the injection; assert the system cannot cause an action: no approval created, no `ExecutionAttempt`, no plan action, no out-of-schema field, no outbound request to a non-allow-listed host, and the injection is flagged for the owner.
4. **Upload fuzz:** wrong magic bytes with right extension, oversize (above the configured cap, default 5 MB), a 21-page PDF (limit 20), filename tricks (path traversal, null bytes, unicode direction overrides, > 50 chars, double extensions), a polyglot (PDF/ZIP, JPEG+HTML), zero-byte file, encrypted PDF, many-files flood; accepted files are served only with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`; no code path fetches a URL found in a document (SSRF grep plus runtime test).
5. **Approvals:** replay of a consumed approval, double-click concurrency (exactly one consume wins), TOCTOU (state changes after approval: RFI `updated_at`, balance, attachment bytes re-hashed, beneficiary fingerprint change each cause the executor to refuse), expired approval, approval by a non-approver role, cross-business approval id.
6. **Payee page tokens:** guessing (entropy and constant-time hashed lookup), expired and revoked tokens, token in referrer (`Referrer-Policy: no-referrer`, `noindex`), generic status by default, rate limit on the route.
7. **Rate limits and headers:** login, upload, payee page and webhook routes limited per the M1-10 table with `429` and `Retry-After`; security headers on all responses (CSP, `X-Content-Type-Options`, `Referrer-Policy`, `Frame-Options` or `frame-ancestors`, HSTS where TLS), cookies `HttpOnly`/`Secure`/`SameSite`.
8. **Audit tampering and kill switch** rows reuse M4-01/M4-02 tests via a mapping check (they must exist and pass).
9. **Fix what fails** in the same PR, each fix with a regression test; failures that need a decision outside this ticket go to `BL-01` with the failing test marked and explained, never skipped silently.
10. **Dependency and secret scans:** `npm audit --omit=dev --audit-level=high` clean (or each remaining advisory justified in a tracked allowlist with reachability reasoning), and `gitleaks` clean over the working tree and full git history.

## Out of scope

- Penetration testing against the live hosted environment or third-party services; all tests run against a local stack and recorded fixtures.
- WAF/DDoS configuration at the platform edge (platform feature, noted in the deployment ticket).
- New product features; only fixes to controls that fail.
- Real secrets: tests use generated canary values, never a real key.

## Acceptance Criteria

- [ ] Every row of the STRIDE table in `docs/architecture.md` §8 maps to at least one named test in `tests/security/README.md`; a check script fails if a row has no test
- [ ] Webhook tests: forged, stale, future-dated and replayed requests are rejected or deduplicated with no state change; a valid fixture event is accepted
- [ ] Cross-tenant test matrix passes for every table with `business_id`
- [ ] Injection tests pass with a hostile stub model that obeys injected instructions: zero actions, zero approvals, zero non-allow-listed outbound requests
- [ ] Upload fuzz matrix passes; 21-page PDF and oversize files are rejected with the documented error; a polyglot is rejected or served inert
- [ ] Approval replay and 20-way concurrent consume yield exactly one success; each TOCTOU change refuses execution
- [ ] Payee token guess/expiry/revoke tests pass; rate limits return `429` within the configured window
- [ ] Header test asserts the full header set on app, API and payee routes
- [ ] `npm audit --omit=dev --audit-level=high` exits 0 and `gitleaks detect` exits 0 on tree and history
- [ ] Any control that failed first has a fix and a regression test in this PR (listed in the PR description)
- [ ] `./scripts/landing-checks.sh` passes

## Deliverables

- `tests/security/**` and `tests/security/README.md` (STRIDE row to test map) plus the map-check script
- Fixes in `apps/web`, `packages/*` for any failing control
- `.github/workflows` job or landing-checks step running the security suite and scans
- Allowlist file for audit advisories only if needed

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"
docker compose up -d postgres
npm run db:migrate
npx vitest run tests/security
python3 scripts/check-stride-map.py
npm audit --omit=dev --audit-level=high
gitleaks detect --no-banner --redact --report-path "$TMPDIR/gitleaks.json"
gitleaks detect --no-banner --redact --log-opts="--all" --report-path "$TMPDIR/gitleaks-history.json"
./scripts/check-no-secrets.sh
./scripts/landing-checks.sh
```

## Handoff → M4-GATE, M5-01

Comment on the issue: the STRIDE row to test map, which controls needed fixes, what was logged to `BL-01`, and the audit/gitleaks results. The gate re-runs `tests/security`; M5-01 may describe security claims only as these tests show.
