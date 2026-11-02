---
title: "M3-06 · Payee status page (hashed token, expiry, no-referrer)"
milestone: "M3 · Hold-Aware Planning"
labels: ["frontend", "security"]
blocked_by: ["M1-04"]
estimate: "4h"
resources: []
needs: ["P-10"]
---

## Context

"Vendors follow up asking if payment was sent, I confirm it was, we both wait." (r/smallbusiness, 2026-04-02, `PROJECT.md` §2). A read-only link lets a payee see where a payment stands without calling the owner, and without exposing a compliance hold: the default shows generic Processing / Sent / Paid / Failed; the owner may opt in per link to "Delayed for verification". The architecture's STRIDE row for information disclosure fixes the controls: generic status by default, owner opt-in, hashed token, expiry, `no-referrer`, `noindex`, rate limit. Carnet never emails or contacts payees (`PROJECT.md` §9): the owner copies the link. Rubric R8 (product, user story 5). The page shows the status projected from the transfer (ADR 0006), never from an RFI.

## Scope

1. **Table** `payee_links` (`packages/db/src/schema/payee-links.ts`, hot file): `id`, `payment_id`, `business_id`, `token_hash` (SHA-256 of the token, unique), `expires_at`, `disclosure_level` (`GENERIC` | `DELAYED_FOR_VERIFICATION`), `revoked_at`, `created_by`, `created_at`, `last_viewed_at`. The raw token is shown once at creation and never stored.
2. **Token**: 256 bits from the platform CSPRNG, base64url (43 characters); lookup is by hash with a constant-time comparison of the hash on the fetched row; the route behaves identically (same status, body shape and rough timing) for unknown, expired and revoked tokens.
3. **Owner API** under `/api/v1/payments/{id}/payee-links` (owner/approver role, scoped by `business_id`, Idempotency-Key on create): create (expiry default from `PAYEE_LINK_TTL_HOURS`, maximum 30 days; disclosure level chosen explicitly, default GENERIC), list, revoke. Owner UI on the payment page: "Create status link", copy button, disclosure toggle with a one-line explanation of what the payee will see, expiry and revoke controls. Builds to `docs/design/` and passes the `ui-reviewer`.
4. **Public page** `/status/<token>` (server component, no auth, no cookies set, no JS required): shows only a status word and the last-updated time. Mapping from the transfer projection: GENERIC maps every non-final in-flight state (including held) to "Processing", SENT to "Sent", PAID to "Paid", FAILED and CANCELLED to "Failed"; DELAYED_FOR_VERIFICATION shows "Delayed for verification" only while the payment is held, otherwise the same words as GENERIC. No amount, currency, payee name, reference, bank detail, RFI, document, business name or ids. A held payment on a GENERIC link must be indistinguishable from an ordinary Processing one.
5. **Headers and abuse controls**: `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow` plus `<meta name="robots">`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, no third-party requests or assets; rate limit by IP and by token-hash prefix using the database counter from M1-10 (limit from `PAYEE_STATUS_RATE_LIMIT_PER_MIN`); 404 body generic for invalid, expired and revoked; logs redact the token (log only the first 6 hash characters).
6. **Never emails anyone**: no mail dependency is added; a test asserts there is no outbound call from the create path.
7. **Tests**: token guessing (a test generates many random tokens and all return the same 404 with no timing-dependent branch on the existence of a row; the rate limiter engages after the limit and returns 429), expiry (a link past `expires_at` returns the generic 404), revoked (404 immediately), headers on 200 and 404, disclosure mapping across all eleven transfer statuses plus held flag for both levels, no financial fields in the response (snapshot of the HTML and of the response body), token stored hashed (the raw token is never found in any table; test scans the row), tenancy (a link for another business's payment cannot be created), owner-only creation.

## Out of scope

- Sending the link by email or any channel; notifying payees; payee accounts or comments.
- Any detail beyond the status word and time; showing RFI state, the reason for a hold, or amounts.
- Per-viewer analytics beyond `last_viewed_at`.

## Acceptance Criteria

- [ ] `curl -sI /status/<valid-token>` returns `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, `Cache-Control: no-store` (test asserts all three on 200 and on 404).
- [ ] 10,000 random 43-character tokens return only 404 (or 429 once rate-limited), with identical body for every one, and no DB row is created or changed.
- [ ] An expired link and a revoked link return the same 404 as an unknown token.
- [ ] The raw token does not exist in any column of any table after creation (test scans all text columns of `payee_links`); `token_hash` is 64 hex characters.
- [ ] For a held payment: a GENERIC link renders "Processing"; a DELAYED_FOR_VERIFICATION link renders "Delayed for verification"; once the transfer is SENT both render "Sent".
- [ ] The response body of the public page contains none of: amount, currency code, payee name, reference, business name, RFI text (assert with a seeded payment whose values are searched for).
- [ ] Status mapping is total over all eleven transfer statuses (test enumerates them).
- [ ] Creating or revoking a link requires an authenticated owner/approver; a viewer receives 403.
- [ ] No email or outbound HTTP call occurs in create, view or revoke (test with a network guard).
- [ ] The owner-side UI passes axe, is keyboard operable, has loading/empty/error states, and passed `ui-reviewer` against `docs/design/`.

## Deliverables

- `packages/db/src/schema/payee-links.ts`, migration, repository
- `apps/web/src/app/status/[token]/page.tsx`, `apps/web/src/app/api/v1/payments/[id]/payee-links/`, owner UI components, strings
- Status mapping in `packages/domain/src/payee-status.ts` (pure, tested)
- Tests and `apps/web/e2e/payee-status.spec.ts`

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; OUT="$(mktemp -d "$TMPDIR/m3-06.XXXXXX")"
npx vitest run packages/domain/src/payee-status 2>&1 | tee "$OUT/map.log"
TEST_DATABASE_URL="${TEST_DATABASE_URL:?set a throwaway database}" \
  npx vitest run apps/web/src/app/status apps/web/src/app/api/v1/payments 2>&1 | tee "$OUT/web.log"
npm run build -w apps/web
npx playwright test apps/web/e2e/payee-status.spec.ts --output "$OUT/pw"
! grep -rEn 'nodemailer|sendgrid|resend|smtp' apps packages --include=package.json --include='*.ts' -il
./scripts/landing-checks.sh --fast
```

## Handoff

- **M3-07** creates a link in the live run, opens it on the deployed host, and shows GENERIC then the opt-in wording while the payment is held.
- **M4-04** includes `/status/<token>` in the security hardening tests; **M4-05** serves a link inside the replay; **M4-07** audits the owner UI.
Post as an issue comment: the route, the new env keys (`PAYEE_LINK_TTL_HOURS`, `PAYEE_STATUS_RATE_LIMIT_PER_MIN`; names only), the status mapping table, and the design-review verdict.
