---
title: "M0-04 · Airwallex spike B: simulate TRANSACTION RFI on plain account, TEXT+ATTACHMENT, partial/full respond, follow_up, close, one-open rule, transfer transition while open, held-funds balance (spike 8), file types/limits, record fixtures"
milestone: "M0 · Recon & Bootstrap"
labels: ["recon", "blocker-risk", "critical"]
blocked_by: ["M0-03"]
estimate: "6h"
resources: ["AIRWALLEX_SANDBOX"]
needs: ["P-03"]
---

## Context

The whole product is an agent that answers Airwallex information requests (RFIs). PROJECT.md §10 names the largest risk: "A plain sandbox account cannot create simulated RFIs", followed by "Only one Transaction RFI may be open at a time", "Respond may reject partial answers; attachment types unknown" and "Held funds are not visible in balances". Rubric R0 and R7 depend on this spike, and ADR 0018 fixes the fallback if check 1 fails: local injection of the documented webhook shape through the same signature verification, labelled in the UI and disclosed in the README. Every UNKNOWN in `docs/evidence/airwallex-rfi-contract.md` is resolved here.

## Scope

Extend the dependency-free scripts under `scripts/spikes/airwallex/` (reuse the M0-03 recorder; credentials from the process environment only, never printed) and run **exactly these eight live checks, in this order**, against the sandbox. Record each request and response as a redacted fixture in `fixtures/airwallex/` (tokens stripped, ids kept). Each check closes any open RFI first (the one-open rule) and states the observed result in the evidence file.

1. **Plain-account creation.** Create a transfer, then `POST /simulation/rfis/create` with `type: TRANSACTION`, a `TRANSFER` source for that transfer, and two questions with custom titles: one `TEXT`, one `ATTACHMENT`. Use no `x-on-behalf-of`. Record: whether it succeeds, the transfer status afterwards, the exact question shape, and the webhook payload if a subscription already exists (otherwise note "pending M0-05").
2. **Partial and repeated respond.** Respond with only one of the two questions; then answer both; then respond again after the RFI is `ANSWERED`. Record statuses and error bodies.
3. **Files.** Upload a PNG, an oversized file (over the documented 20 MB limit), a PDF and a JPEG via `files.sandbox.airwallex.com`; attach each to an `ATTACHMENT` answer and record which are accepted by upload and which by respond.
4. **Transfer transition while open.** Transition the transfer (`SENT`, then `PAID`, and a `FAILED` run) while the RFI is open; record the RFI status and the transfer fields.
5. **Close.** Close the RFI via `POST /simulation/rfis/{id}/close`; record the response body and the following `GET /rfis/{id}`.
6. **Long TEXT.** Find the TEXT answer length limit by bisection (record the largest accepted and smallest rejected length, and the error body).
7. **Sources.** Does the RFI webhook or the fetched RFI carry `sources`? Test an RFI with several sources, and with none (the orphan case); record how a question maps to a transfer.
8. **Held funds.** Record balances before transfer creation, after creation, and while the RFI is open, to settle whether held funds are visible.

Also: `follow_up` (reopen answered questions by id and append a new one, including a repeated question title) and the one-open-RFI-per-type rule (second create while one is open: error body).

**Decision on fallback.** If check 1 fails on a plain account, stop the remaining checks that depend on it, record the exact error, and write the decision for ADR 0018 (fallback: local injection of the documented webhook shape through the same signature check, labelled) in `docs/evidence/rfi-spike-decision.md` and as an issue comment for the owner. Do not edit the accepted ADR; propose an amendment in that comment. Run the organiser question from M0-01 against the result.

Update `docs/evidence/airwallex-rfi-contract.md`: replace every **UNKNOWN** with the observed behaviour, with the fixture name that proves it and the date. Keep the remaining text intact.

## Out of scope

- Webhook subscriptions and delivery ordering (M0-05)
- Production RFI intake, the document model, or any model call
- Any request against a non-sandbox host or with production keys
- Concurrent runs (the sandbox allows one open TRANSACTION RFI)

## Acceptance Criteria

- [ ] Checks 1 to 8 each have a fixture set in `fixtures/airwallex/` and a line in the evidence file stating what was observed (or the exact failure)
- [ ] `grep -c UNKNOWN docs/evidence/airwallex-rfi-contract.md` is 0, or each remaining mention names the check that could not run and why
- [ ] The evidence file states: partial respond accepted or rejected; attachment types accepted; text length limit; whether closing moves the transfer; whether `sources` are present; whether held funds appear in balances
- [ ] `follow_up` reopen and the one-open rule were exercised and their error or success bodies recorded
- [ ] A decision is recorded in `docs/evidence/rfi-spike-decision.md`: "plain account creates RFIs: yes" or the fallback proposal for ADR 0018
- [ ] No fixture or script output contains a token, key or the webhook secret (pattern scan passes)
- [ ] After the run, no RFI is left open on the account

## Deliverables

- `scripts/spikes/airwallex/rfi-*.mjs`
- `fixtures/airwallex/rfi-*.json`, `files-*.json`, `balances-*.json` (names per check)
- `docs/evidence/airwallex-rfi-contract.md` (updated), `docs/evidence/rfi-spike-decision.md`

## Validation Gate

```bash
set -euo pipefail
test -n "${AIRWALLEX_CLIENT_ID:-}" && test -n "${AIRWALLEX_API_KEY:-}" || { echo "missing sandbox env" >&2; exit 2; }
T="${TMPDIR:-/tmp}/m0-04"; rm -rf "$T"; mkdir -p "$T"
node scripts/spikes/airwallex/rfi-run-all.mjs >"$T/out.txt" 2>&1
! grep -F "$AIRWALLEX_API_KEY" "$T/out.txt"
for n in 1 2 3 4 5 6 7 8; do ls fixtures/airwallex | grep -q "rfi-check$n" || { echo "missing fixtures for check $n" >&2; exit 1; }; done
left=$(grep -c 'UNKNOWN' docs/evidence/airwallex-rfi-contract.md || true)
echo "UNKNOWN remaining: $left"; [ "$left" -eq 0 ]
test -s docs/evidence/rfi-spike-decision.md
if grep -R -l -E '"(token|access_token|api_key|client_secret|secret)" *: *"[^"<]{8,}"' fixtures/airwallex; then echo "unredacted secret" >&2; exit 1; fi
if grep -R -F -l "$AIRWALLEX_API_KEY" fixtures docs/evidence; then echo "key leaked" >&2; exit 1; fi
node scripts/spikes/airwallex/assert-no-open-rfi.mjs
./scripts/check-no-secrets.sh
```

## Handoff

- M0-05 needs the RFI creation helper, and the open/closed state discipline (close before exit).
- M1-03 (adapter, simulation port), M1-05 (webhook route), M2-* (RFI intake, respond, follow-up round) replay these fixtures and read the updated evidence file; M2-05 needs the respond rules (partial, attachments, text limit).
- M3-02/M3-03 (hold-aware planner) need the held-funds finding.
- The owner reads the decision file: if the fallback applies, ADR 0018 is amended in the next planning pass and the README disclosure becomes a hard requirement.
- Post on the issue: the decision, the table of eight results, and every difference from the documented contract.
