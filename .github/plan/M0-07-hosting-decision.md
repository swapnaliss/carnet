---
title: "M0-07 · Hosting decision (Railway | Render | AWS): verify free-tier/DB/backups/region, account, public URL"
milestone: "M0 · Recon & Bootstrap"
labels: ["owner", "meta"]
blocked_by: ["M0-00"]
estimate: "2h"
resources: []
needs: ["P-02", "P-07", "P-12", "P-21"]
---

## Context

The Airwallex webhook subscription needs a stable public HTTPS URL early (PROJECT.md §10: "Hosting undecided until M0-07"), the judging window needs an always-on worker (ADR 0005 outbox and worker, ADR 0014 platform-neutral container deployment), and rubric R9 requires a working demo. ADR 0014 left the choice to this ticket: Railway, Render, or AWS if the organisers grant credits (question 3 of M0-01). Prices and free tiers change; every row must be verified today, not recalled.

## Scope

**Owner decision ticket**: only the owner can decide, create the account and add billing, so it carries `owner`. A worker prepares everything the decision needs.

1. **Worker: comparison rows** in `docs/budget.md` (a "Hosting" section; M0-00 owns the rest of the file) for Railway, Render and AWS, each filled from that provider's pricing and docs pages fetched on the day the ticket runs, with the page URL and the date next to each cell: free tier or trial credits and their expiry; sleep-on-idle behaviour; managed Postgres price, size limits, backups and point-in-time recovery; always-on background worker support and price; region options; custom domain and HTTPS; deploy from Docker image or Git; log retention; monthly cost for web + worker + Postgres at our scale for the build period and for the judging window. Mark any cell that could not be verified as "unverified", never guess.
2. **Worker: recommendation** (one paragraph) against the ADR 0014 contract: container, `DATABASE_URL`, environment variables, public HTTPS URL, `/healthz`, restart policy, at least one always-on worker.
3. **Owner: ask about AWS credits first** (M0-01), then decide, create the account and a project, add the budget alert from M0-00, and set only variable names in the platform (values stay in the platform and the owner's `.env`).
4. **Record the choice** as `docs/adr/0019-hosting-platform.md` (tracked; same ADR format as the others: Status, Context, Decision, Alternatives considered, Consequences) and in `.dev-refs.md` (gitignored) with the project id and dashboard link.
5. **Placeholder**: deploy a minimal container (a `/healthz` handler; an image built from the M0-02 Dockerfile in `web` mode is sufficient) so that a public HTTPS URL answers. M0-05 needs this URL for the webhook subscription.

## Out of scope

- The real deployment pipeline, migrations on deploy, rollback (M1-06)
- Production environment variables beyond the placeholder
- Buying anything beyond the approved ceiling (M0-00 sets it)

## Acceptance Criteria

- [ ] `docs/budget.md` Hosting section has all three providers with every field above and a source URL and date per cell
- [ ] The owner's decision is recorded in `docs/adr/0019-hosting-platform.md` and `.dev-refs.md` (the latter untracked)
- [ ] A public HTTPS URL for the placeholder container exists and `/healthz` returns 200
- [ ] The chosen host meets the ADR 0014 contract, with always-on worker support and a backup story checked in the comparison
- [ ] The monthly cost fits the ceiling approved in M0-00, or the owner has recorded the new ceiling
- [ ] No credential appears in any tracked file

## Deliverables

- `docs/budget.md` (Hosting section), `docs/adr/0019-hosting-platform.md`, `.dev-refs.md` (untracked)

## Validation Gate

```bash
set -euo pipefail
test -s docs/adr/0019-hosting-platform.md
for s in Status Context Decision 'Alternatives considered' Consequences; do grep -q "$s" docs/adr/0019-hosting-platform.md || { echo "ADR lacks $s" >&2; exit 1; }; done
for p in Railway Render AWS; do grep -q "$p" docs/budget.md || { echo "budget lacks $p" >&2; exit 1; }; done
if grep -n -i 'unverified' docs/budget.md; then echo "unverified hosting cells remain (allowed only if justified in the ADR)" >&2; fi
git check-ignore -q .dev-refs.md
URL=$(grep -o 'https://[^ )]*' .dev-refs.md | grep -i -m1 -E 'carnet|healthz|up\.railway|onrender|amazonaws|\.' )
test -n "$URL"
curl -fsS --max-time 20 "${URL%/}/healthz" >"${TMPDIR:-/tmp}/m0-07-health.txt"
./scripts/check-no-secrets.sh
```

## Handoff

- M0-05 needs the public URL for the webhook subscription (owner step).
- M1-06 (deployment pipeline) needs the platform, project, region, how to deploy a Docker image, and the database plan; M1-02 needs the Postgres version offered.
- M0-GATE re-checks `/healthz`.
- Post on the issue: the decision, the comparison summary (text), monthly cost, and the URL (a public URL is fine; no dashboards or ids).
