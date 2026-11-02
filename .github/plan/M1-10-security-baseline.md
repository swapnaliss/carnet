---
title: "M1-10 · Security baseline: rate-limit table, headers, input validation"
milestone: "M1 · Walking Skeleton"
labels: ["security"]
blocked_by: ["M1-04"]
estimate: "4h"
resources: []
needs: []
---

## Context

ADR 0004 (zod validation at every route, one error format, rate limits on login, approval and webhook
routes with a database counter) and ADR 0012 (tenancy, server-side authorisation). The STRIDE table in
`docs/architecture.md` §8 and the risk "Public repo leaks a secret" (§10) drive the CI scans. M4-04
later adds fuzz and injection tests; this ticket lays the baseline every route inherits.

## Scope

1. **Security headers** (Next config or middleware, all responses): `Content-Security-Policy`
   (default-src 'self', no inline script except a nonce, frame-ancestors 'none', object-src 'none',
   base-uri 'self', form-action 'self'), `X-Content-Type-Options: nosniff`, `Referrer-Policy:
   strict-origin-when-cross-origin` (payee pages tighten to `no-referrer` in M3-06),
   `Strict-Transport-Security` in production, `Permissions-Policy` denying camera/microphone/
   geolocation, `X-Frame-Options: DENY`. CSP must not break the M1-07 shell.
2. **Input validation helper** `defineRoute({ method, auth, body?, query?, params?, handler })` that
   parses with zod schemas from `packages/domain`, returns the shared 400 error with field issues
   (no stack traces), enforces body size cap (config, default 5 MB, lower on JSON routes), requires
   `Content-Type` for bodies, and wires `requireRole` from M1-04. Existing M1 routes (payments from
   M1-08 may follow; webhook route and auth routes now) are migrated to it, except the webhook route
   which needs the raw body and uses a documented raw-body variant.
3. **Rate-limit helper** (consolidating the M1-04 limiter into the one place): atomic upsert on
   `rate_limits(key, window_start, count)`, fixed window, keys by route + subject (user id, email or
   IP), returns `{ allowed, remaining, retryAfter }`; applied to login, approval (placeholder
   registration so M2-07 only calls it), and the webhook route (generous: 600 per minute per source
   IP so a retry storm cannot DoS the DB, never rejecting a valid signature burst under normal load).
   Expired windows are pruned by the worker.
4. **Error format** applied everywhere: 400/401/403/404/409/413/429/500 with the closed code enum; 500
   never leaks internals.
5. **CI**: dependency audit (`npm audit --omit=dev --audit-level=high` failing the job) and secret scan
   (`gitleaks` plus `./scripts/check-no-secrets.sh`) in the CI workflow; documented allowlist file
   for any accepted advisory with an expiry date.
6. **Tests**: cross-tenant access across all existing routes and rate-limit behaviour.

## Out of scope

- Upload validation (M2-01), injection payload and fuzz suites (M4-04), WAF or platform firewall rules
- Audit log hashing (M4-01), approval binding (M2-07)

## Acceptance Criteria

- [ ] An integration test fetches `/login`, `/healthz` and an API route and asserts each header above is present with the expected value; the CSP has `frame-ancestors 'none'` and no `unsafe-inline` for scripts
- [ ] Playwright smoke on the shell home and `/login` reports zero CSP violations in the console
- [ ] `defineRoute`: invalid body returns 400 with the documented shape and field paths; an unknown extra field is rejected (strict schemas); oversize body returns 413; wrong content type returns 415 or 400 per the enum; the handler is never invoked on invalid input (spy)
- [ ] A test enumerates every `route.ts` under `apps/web/src/app/api` and fails if one neither uses `defineRoute` nor is on the documented raw-body allowlist (webhook, auth catch-all)
- [ ] Rate limit: the (N+1)th request in a window returns 429 with `retry-after`; counters are per subject; two parallel bursts never exceed N allowed (atomic upsert test with 50 concurrent calls); a new window resets the count
- [ ] Webhook route: a valid-signature burst of 100 events within a minute is all accepted; 601 requests from one IP within a minute start returning 429
- [ ] Cross-tenant: for each route taking an id, business A's session gets 404 for business B's id; viewer role gets 403 on mutations
- [ ] 500 error body contains no stack trace or SQL text (test forces a throw)
- [ ] CI workflow runs `npm audit` and `gitleaks`, and a seeded fake secret-shaped string in a throwaway test file makes `./scripts/check-no-secrets.sh` exit non-zero (the file lives under `$TMPDIR` and is staged only in the test copy)
- [ ] `npm run test` for affected workspaces exits 0

## Deliverables

- `apps/web/next.config.ts` headers (or `middleware.ts`), `apps/web/src/lib/{define-route,ratelimit,errors}.ts`
- `packages/db/src/repos/rate-limits.ts`, worker prune step in `apps/web/src/worker/`
- `.github/workflows/ci.yml` updates (audit, gitleaks), `.audit-allowlist.json`
- Tests: `apps/web/test/security/*.test.ts`, `apps/web/e2e/csp.spec.ts`
- `.env.example`: `RATE_LIMIT_WEBHOOK_PER_MIN`, `MAX_JSON_BODY_BYTES` (keys only)

## Validation Gate

```bash
set -euo pipefail
docker compose up -d postgres
npm run db:migrate -w packages/db
npm run test -w apps/web -- security
npm run typecheck -w apps/web
npm audit --omit=dev --audit-level=high
gitleaks detect --no-banner --redact
./scripts/check-no-secrets.sh
# canary: the scanner test (a vitest case) stages a secret-shaped string in a temp repo under $TMPDIR and expects non-zero
npm run test -w apps/web -- security/secret-scan
```

## Handoff

M2-01 (upload routes use `defineRoute` and the body cap), M2-07 (approval rate limit and idempotency),
M3-06 (payee route tightens headers), M4-04 (extends the tests). Comment on the issue: how to declare a
route, the limiter signature and window constants, the CSP nonce approach, and the audit allowlist
policy.
