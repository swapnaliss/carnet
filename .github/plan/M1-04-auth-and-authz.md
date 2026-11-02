---
title: "M1-04 · Auth (better-auth) + server-side authZ scoping + seed users"
milestone: "M1 · Walking Skeleton"
labels: ["backend", "security"]
blocked_by: ["M1-02"]
estimate: "4h"
resources: []
needs: []
---

## Context

ADR 0012: better-auth 1.7.15 email and password sessions, roles owner, approver, viewer, server-side
authorisation scoped by `business_id`, a seeded read-only judge login, and a database-counter rate
limit on login. Supports R3 (approvals are stated per role) and the cross-tenant threat in
`docs/architecture.md` §8. M3-06 and M2-01 depend on the context object produced here.

## Scope

1. Integrate better-auth 1.7.15 with the Drizzle adapter (credential tables generated into a
   migration owned by `packages/db`), session cookie `HttpOnly`, `Secure` in production,
   `SameSite=Lax`; config from `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`.
2. `users` rows carry `business_id` and `role`; sign-up is disabled in production (users come from
   the seed script), so there is no public registration surface.
3. **AuthZ**: `requireSession()` and `requireRole(...roles)` helpers returning
   `ctx: { businessId, userId, role }` for route handlers and server components; the context is the
   only way to call repositories (M1-02). Role matrix: owner everything; approver may approve but not
   change settings; viewer is read-only (any non-GET route returns 403 with the shared error format).
4. **Seed users** in a reusable function `seedDemoUsers(db)` (called by M1-06 `scripts/setup.ts`):
   one demo business, an owner, an approver and a read-only judge (viewer). Passwords come from env
   keys `SEED_OWNER_PASSWORD`, `SEED_APPROVER_PASSWORD`, `SEED_JUDGE_PASSWORD`; absent keys in
   production abort the seed (no default passwords). Idempotent.
5. **Login rate limit**: 5 failed attempts per email per 15 minutes and 20 per IP per 15 minutes via
   the `rate_limits` table (atomic upsert-increment); the limiter helper is generic so M1-10 reuses it.
   (M1-10 owns hardening the helper's API; this ticket wires login only.)
6. Minimal pages: `/login` (unstyled-acceptable form using shadcn primitives once M1-07 lands; no
   design review claim here) and sign-out. No UI polish in this ticket.

## Out of scope

- Approval flows and approval binding (M2-07), payee links (M3-06)
- Password reset email, OAuth providers, MFA
- Styling the login page to the design system (done in M1-08 when it is composed into the app)

## Acceptance Criteria

- [ ] Integration test: valid credentials create a session cookie that is `HttpOnly` and `SameSite=Lax`; invalid credentials return 401 with the shared error format and no user-existence hint
- [ ] Sign-up endpoint returns 404 or 403 when `NODE_ENV=production`
- [ ] Role matrix test: viewer gets 403 on a POST route guarded by `requireRole("owner","approver")`; approver passes; owner passes; unauthenticated gets 401
- [ ] Cross-tenant test: a session of business A requesting a route with a business B resource id gets 404 (not 403, not data)
- [ ] Rate limit test: the sixth failed login for one email within 15 minutes returns 429 with `retry-after`; a successful login on another email is unaffected; the counter is a row in `rate_limits` (asserted by query)
- [ ] `seedDemoUsers` run twice yields exactly three users; running it with the password keys unset and `NODE_ENV=production` exits non-zero
- [ ] No password or session token appears in logs (test captures log output during a login)
- [ ] `npm run test -w apps/web` auth tests and `npm run test -w packages/db` pass

## Deliverables

- `apps/web/src/lib/auth.ts`, `apps/web/src/app/api/auth/[...all]/route.ts`, `apps/web/src/lib/authz.ts`
- `apps/web/src/app/login/page.tsx`
- `packages/db/src/seed/demo-users.ts`, migration for credential tables
- `packages/db/src/ratelimit.ts` (or `apps/web/src/lib/ratelimit.ts` if M1-10 prefers it app-side; one place only)
- Tests under `apps/web/test/auth/*.test.ts`
- `.env.example` entries (keys only): `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `SEED_OWNER_PASSWORD`, `SEED_APPROVER_PASSWORD`, `SEED_JUDGE_PASSWORD`

## Validation Gate

```bash
set -euo pipefail
docker compose up -d postgres
npm run db:migrate -w packages/db
npm run test -w apps/web -- auth
npm run typecheck -w apps/web
# seed is idempotent
export SEED_OWNER_PASSWORD="$(openssl rand -hex 12)" SEED_APPROVER_PASSWORD="$(openssl rand -hex 12)" SEED_JUDGE_PASSWORD="$(openssl rand -hex 12)"
npx tsx packages/db/src/seed/run.ts && npx tsx packages/db/src/seed/run.ts
./scripts/check-no-secrets.sh
```

## Handoff

M1-08 (logged-in owner), M1-10 (reuses the rate-limit helper and `requireRole`), M2-01, M3-06, and
M4-05 (judge replay). Comment on the issue: the `ctx` type, the role matrix, the three env key names
for seed passwords, and where the judge account is labelled read-only.
