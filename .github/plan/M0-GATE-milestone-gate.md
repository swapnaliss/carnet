---
title: "M0-GATE · Gate (runs `python3 scripts/check-prereqs.py`)"
milestone: "M0 · Recon & Bootstrap"
labels: ["gate"]
blocked_by: ["M0-00", "M0-01", "M0-02", "M0-03", "M0-04", "M0-05", "M0-06", "M0-07", "M0-08"]
estimate: "1h"
resources: []
needs: []
---

## Context

M1 builds on everything M0 learned: fixtures the adapter replays, evidence the domain model relies on, a repo that lands code in minutes, a host with a public URL, and a dataset to score against. The gate proves M0 from a clean state so the milestone can close and `/start-milestone` can open M1 without surprises. It also enforces the rule that public artefacts hold no secrets (PROJECT.md §10, R9).

## Scope

Run the validation below from a fresh clone of the working tree. The gate creates no new product artefacts; it reports. It covers: landing checks, prerequisites, toolchain smoke, fixture presence and redaction, evidence file completeness, and a clean-state reset.

Checks in detail:

1. `./scripts/landing-checks.sh` (includes the secret scan)
2. `python3 scripts/check-prereqs.py` (as demanded by M0-00); every required item present, or the failing items listed for the owner
3. `scripts/toolchain-smoke.sh` and `make reset` within the M0-02 budgets
4. Fixtures exist for each spike (`fixtures/airwallex/`, `fixtures/airwallex/webhooks/`, `fixtures/anthropic/`, `fixtures/dataset/`) and contain no token, key or webhook secret patterns
5. `docs/evidence/airwallex-rfi-contract.md` has no unexplained UNKNOWN; `docs/evidence/` has the money-path, webhook, Anthropic, toolchain and dataset notes; `docs/adr/0019-hosting-platform.md` exists
6. Placeholder host `/healthz` answers
7. No RFI left open on the sandbox account

## Out of scope

- Fixing failures (open `BL-01` entries or reopen the failing ticket)
- Any new live spike run beyond the read-only checks above
- Starting M1

## Acceptance Criteria

- [ ] Every command in the Validation Gate exits 0 from a fresh clone
- [ ] The owner has read the M0-04 decision (plain account creates RFIs, or the fallback proposal) and the hosting ADR
- [ ] Any failure is recorded on the issue with the ticket it belongs to

## Deliverables

- None (a gate comment on the issue with command output summary)

## Validation Gate

```bash
set -euo pipefail
T="${TMPDIR:-/tmp}/m0-gate"; rm -rf "$T"; mkdir -p "$T"
git clone -q . "$T/clone" && cp -r fixtures "$T/clone/" 2>/dev/null || true
cd "$T/clone"
npm ci
./scripts/landing-checks.sh
python3 scripts/check-prereqs.py
./scripts/toolchain-smoke.sh
make reset
for d in fixtures/airwallex fixtures/airwallex/webhooks fixtures/anthropic fixtures/dataset; do
  test -n "$(ls -A "$d" 2>/dev/null)" || { echo "empty or missing $d" >&2; exit 1; }
done
if grep -R -l -E '(sk-an[t]-[A-Za-z0-9_-]{8,}|"(token|access_token|api_key|client_secret|secret)" *: *"[^"<]{8,}"|Bearer [A-Za-z0-9._-]{20,})' fixtures docs; then echo "secret pattern in fixtures or docs" >&2; exit 1; fi
if [ -n "${AIRWALLEX_API_KEY:-}" ] && grep -R -F -l "$AIRWALLEX_API_KEY" fixtures docs; then echo "api key in tracked files" >&2; exit 1; fi
n=$(grep -c 'UNKNOWN' docs/evidence/airwallex-rfi-contract.md || true); echo "UNKNOWN: $n"; [ "$n" -eq 0 ]
for f in airwallex-money-path airwallex-webhooks anthropic-spike toolchain dataset rfi-spike-decision; do test -s "docs/evidence/$f.md" || { echo "missing evidence $f" >&2; exit 1; }; done
test -s docs/adr/0019-hosting-platform.md
make down
echo "M0 gate: ok"
```

(Live read-only checks that need the owner's `.env`: run `node scripts/spikes/airwallex/assert-no-open-rfi.mjs` and curl the placeholder host `/healthz` from `.dev-refs.md` outside the clean clone, then paste the results on the issue.)

## Handoff

- M1-01 through M1-07 are unblocked by this gate: M1-03 needs the fixtures and evidence, M1-06 needs the host, M1-02 needs the repo, M1-07 needs the bootstrap.
- Post on the issue: gate output summary, the list of fixture files by directory, the open decisions the owner must confirm, and any BL-01 entries raised.
