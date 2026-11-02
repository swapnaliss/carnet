---
title: "M0-03 · Airwallex spike A: auth, funding, beneficiary, transfer, transitions, FX, balances; record fixtures"
milestone: "M0 · Recon & Bootstrap"
labels: ["recon", "blocker-risk"]
blocked_by: ["M0-00", "M0-02"]
estimate: "5h"
resources: ["AIRWALLEX_SANDBOX"]
needs: ["P-03"]
---

## Context

Rubric R0 (uses Airwallex APIs) and R7 (simulation behind one interface) rest on a typed adapter (M1-03) whose contract tests replay recorded real responses (ADR 0018, CLAUDE.md: no mocks in the product path). We have docs but no live call yet. This spike proves the money-path calls against the real sandbox and records redacted fixtures. It is a risk reducer for PROJECT.md §10: "Timeouts or crashes around money calls" (request_id behaviour) and "Held funds are not visible in balances" (balances baseline for M0-04).

## Scope

Write small dependency-free Node scripts (built-in `fetch`, `FormData`, `crypto`) under `scripts/spikes/airwallex/`, reading credentials from the process environment only: `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY`, `AIRWALLEX_BASE_URL`, `AIRWALLEX_FILES_URL`. Scripts never print header values, tokens or the key; the recorder redacts tokens and `Authorization` before writing. **Owner action (prerequisite from M0-00):** sandbox account and API key present in `.env`; a worker stops and comments if absent.

Run, in order, and record request and response for each (fixtures in `fixtures/airwallex/`, one JSON file per call, names like `auth-login.json`; ids stay, tokens are stripped):

1. **Auth**: `POST /api/v1/authentication/login`, token lifetime (docs: 30 minutes), behaviour on an expired or invalid token.
2. **Global account funding** via the simulation deposit endpoint; confirm the balance moves.
3. **Beneficiaries**: fetch the schema (`/beneficiary_api_schemas/generate` or the documented equivalent), validate, then create two as in the builder guide: **US, USD, LOCAL** and **DE, EUR, SWIFT**. Record the required-field sets and validation error shapes (one deliberately bad payload).
4. **Balances**: current balances before and after each step (baseline for M0-04 held-funds check).
5. **FX**: current rate, quote, conversion (create and fetch); record fields and any quote expiry.
6. **Transfers**: create with LOCAL and SWIFT; fetch; list; behaviour on reusing the same `request_id` (idempotency) and on a changed body with the same `request_id`.
7. **Simulation**: `POST /simulation/transfers/{id}/transition` through `PROCESSING`, `SENT`, `PAID`, and to `FAILED` with each documented `failure_type`; record the resulting transfer fields.
8. **Cross-cutting**: the `x-request-id`/`request_id` behaviour on responses and errors, the error body shape, and rate-limit behaviour (burst above 10 requests to one endpoint; record the status and any `Retry-After`).

Update `docs/evidence/airwallex-rfi-contract.md` only for facts this spike settles (limits, request_id), and add `docs/evidence/airwallex-money-path.md` with the observed field names, enums and error shapes the M1-03 adapter needs. Cite only the evidence file and observed fixtures.

## Out of scope

- RFIs, file upload, webhooks (M0-04, M0-05)
- The production adapter, retries, or typed wrappers (M1-03)
- Production keys or any non-sandbox host
- Spending beyond the sandbox: nothing here costs money

## Acceptance Criteria

- [ ] Each of the eight steps ran against the sandbox and has at least one redacted fixture in `fixtures/airwallex/`
- [ ] Both beneficiary routes (US USD LOCAL, DE EUR SWIFT) created and a LOCAL and a SWIFT transfer created; both reached `PAID` and one reached `FAILED` via simulation with each documented `failure_type`
- [ ] Rate-limit and `request_id` behaviour written down in `docs/evidence/airwallex-money-path.md` with the fixture names that prove it
- [ ] Scripts print no secret: running with canary env values and grepping stdout/stderr and `fixtures/airwallex/` finds none
- [ ] Fixtures contain no bearer token, API key or client secret (pattern scan passes)
- [ ] The spike script can be re-run from scratch idempotently (new `request_id`s) and the run leaves the account usable for M0-04

## Deliverables

- `scripts/spikes/airwallex/*.mjs` (dependency-free)
- `fixtures/airwallex/*.json`
- `docs/evidence/airwallex-money-path.md`; `docs/evidence/airwallex-rfi-contract.md` touched only for settled facts

## Validation Gate

```bash
set -euo pipefail
test -n "${AIRWALLEX_CLIENT_ID:-}" && test -n "${AIRWALLEX_API_KEY:-}" || { echo "missing sandbox env" >&2; exit 2; }
T="${TMPDIR:-/tmp}/m0-03"; rm -rf "$T"; mkdir -p "$T"
export CANARY_SECRET=canary-m0-03-xyz
node scripts/spikes/airwallex/run-all.mjs >"$T/out.txt" 2>&1
! grep -F -e "$AIRWALLEX_API_KEY" -e canary-m0-03-xyz "$T/out.txt"
ls fixtures/airwallex/*.json | wc -l | awk '{ exit ($1 >= 15 ? 0 : 1) }'
for k in auth beneficiar balance fx transfer transition; do ls fixtures/airwallex | grep -qi "$k" || { echo "no fixture for $k" >&2; exit 1; }; done
if grep -R -l -E '"(token|access_token|api_key|client_secret)" *: *"[^"<]{8,}"' fixtures/airwallex; then echo "unredacted token" >&2; exit 1; fi
if grep -R -F -l "$AIRWALLEX_API_KEY" fixtures/airwallex docs/evidence; then echo "key leaked" >&2; exit 1; fi
test -s docs/evidence/airwallex-money-path.md
./scripts/check-no-secrets.sh
```

## Handoff

- M0-04 needs a funded account, a created beneficiary, a helper to create a transfer, the baseline balances, and the shared recorder module.
- M1-03 (adapter and contract tests) replays these fixtures and needs the field and error-shape notes.
- M1-01 (payment projection) needs the transition fixtures for all observed statuses.
- Post on the issue: the list of fixture files, the rate-limit and `request_id` findings, and any behaviour that differs from the docs.
