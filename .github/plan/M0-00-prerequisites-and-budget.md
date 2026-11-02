---
title: "M0-00 · Prerequisites and budget"
milestone: "M0 · Recon & Bootstrap"
labels: ["recon", "meta", "blocker-risk", "critical"]
blocked_by: []
estimate: "2h"
resources: []
needs: []
---

## Context

`/start-milestone` is meant to run for hours without the owner. It fails when a worker reaches a
step that needs something only the owner can provide (an API key in `.env`, a console toggle, an
OAuth scope, a paid plan) and waits there unseen. This ticket finds **every** such dependency up
front, so the owner can provide them in one sitting and every later ticket can check its own
prerequisites in its first minute (`/start` Phase 1, `scripts/waves.py` holds).

This ticket **gathers and decides**. It installs, enables, registers and buys nothing.

## Scope

Read **every ticket in `.github/plan/`** plus `PROJECT.md` (stack, services and spend) and inventory:

1. **Cloud services and APIs** per ticket, with region or plan constraints
2. **Accounts and registrations** (cloud project, billing, third-party platforms, video hosting,
   social accounts, the hackathon dashboard), and their approval lead times
3. **Credentials and where each lives**: local auth, OAuth scopes (e.g. `gh` needs `workflow` to
   push `.github/workflows/`), service accounts, secrets (Secret Manager name + `.env` key name).
   Who creates each, and how. **Never record a value**
4. **Console-only steps** no CLI can do, with the exact console path
5. **Local tools** with minimum versions (runtimes, Docker daemon, cloud CLI, IaC CLI, emulators and
   their runtime needs such as Java, secret scanner, media tools for the video gate, browsers)
6. **Purchases and subscriptions**: buy / don't buy, and why
7. **Running costs**: per service at our scale, for development **and** for the judging window
   (always-on instances, model spend for evals, storage, logging/tracing). Free-tier and credit
   status and expiry. If a host's free tier does not fit, say what the paid tier costs
8. **Owner decisions** needed before the build (budget ceiling, always-on during judging, insurance
   registrations for fallbacks)
9. **Standing approvals**: every routine owner action the plan will hit repeatedly (merging green
   PRs, test-network or preview deploys, catalog or store publishes, approval merges). The owner pre-approves or
   declines each class once; approved classes become allow rules in `.claude/settings.json` and a
   list in `CLAUDE.md`, so the build never pauses on them. Declined ones stay on the owner list,
   batched one sitting per milestone batch

Make it enforceable:

- `.github/plan/prereqs.json` (the source; shape documented in `scripts/check-prereqs.py`), each
  item with a `verify` command that proves presence **without printing a value**
- `docs/PREREQS.md` rendered from it: `python3 scripts/check-prereqs.py --render`
- `docs/budget.md`: cost table, assumptions, development total, judging-window total, the ceiling
  the owner approves, and the budget alerts that enforce it
- `needs: [P-..]` frontmatter on **every** ticket (empty list allowed), then re-sync issues
- An **owner checklist** comment on this issue: everything only the owner can do, in dependency
  order, groupable into one sitting

## Known so far

From the read-only machine and account check on 2 Nov 2026 (full table in `.kickoff-state.md`); verify, do not assume:

- **Present:** Node 24.22.1, npm 11.19.1, Python 3.14.4, Docker 29.1.3 with the daemon running, git 2.53.0, gh 2.46.0 logged in as `swapnaliss`, ffmpeg 8.0.1, gitleaks installed, google-chrome and firefox, Vercel CLI 65.2.0 (not needed: Vercel is not the host), 4 cores, 14 GB RAM, 309 GB free disk.
- **Missing locally:** `pnpm` (not needed; npm workspaces), `psql` and `redis-server` (use Docker Postgres), `cloudflared` (optional tunnel for local webhooks).
- **gh scopes:** `gist`, `read:org`, `repo`, `workflow` for `swapnaliss`.
- **Only the owner can provide:** Airwallex sandbox account and API key; the Airwallex webhook subscription (needs a public HTTPS URL); the Claude Console organisation and API key (hackathon credits: $100, one claim, 90-day validity, first-party API only, arrive 1-2 business days after claiming); the hosting decision and account (Railway, Render or AWS if the organisers grant credits); Slack questions to the organisers (deadline 13 vs 15 Nov, AWS credits, rubric, RFI sandbox support, prior-work wording); recording the video; making the repo public at submission.
- **Costs known:** Airwallex sandbox free; Anthropic $100 grant; Haiku 5.5 $0.10/$0.50 and Sonnet 5.5 $2/$10 per million tokens; hosting assumed $5-20/month until M0-07 decides.
- **Standing approvals to propose:** merge green PRs to `main`; deploy `main` to the chosen hosting environment; live Airwallex sandbox calls (never production keys); Anthropic spend within the caps in `.github/plan/resources.json`; `docker compose` local stack; `gh` issue, PR and milestone operations on `swapnaliss/carnet`.
- **Seed:** `.github/plan/prereqs.json` already lists P-01..P-07; this ticket completes and corrects it.

## Out of scope

- Doing any of the owner's actions, installing tools, enabling services
- Changing any ticket's scope (only add `needs:`); a ticket that looks wrong goes to BL-01

## Acceptance Criteria

- [ ] Every ticket file read; each prerequisite lists the tickets that need it
- [ ] Every credential says where it lives and contains **no value**
- [ ] Every console-only step has an exact console path
- [ ] `docs/budget.md` has development and judging-window totals with assumptions, and the
      purchases decision
- [ ] `check-prereqs.py` runs every item, exits non-zero while a required item is missing, and
      prints no secret (run with a canary value set and grep the output for it)
- [ ] Every ticket has a `needs:` field; issues re-synced
- [ ] Owner checklist comment posted
- [ ] Standing approvals decided by the owner, recorded on this issue, and the approved classes
      present as allow rules in `.claude/settings.json`

## Deliverables

- `.github/plan/prereqs.json`, `docs/PREREQS.md`, `docs/budget.md`
- `needs:` frontmatter on every `.github/plan/*.md`

## Validation Gate

```bash
python3 scripts/check-prereqs.py --render; echo "exit $?"   # non-zero until the owner finishes
python3 scripts/check-prereqs.py --json | jq 'length'
grep -L '^needs:' .github/plan/*.md | wc -l                  # expect 0
CANARY_SECRET=canary-value-123 python3 scripts/check-prereqs.py 2>&1 | grep -c canary-value-123   # expect 0
./scripts/check-no-secrets.sh
```

## Handoff → every ticket with a non-empty `needs:`, and the M0 gate

Comment: the owner checklist, the approved budget ceiling, and which `P-` ids each downstream ticket
needs. Post on the M0 gate that its validation must include `python3 scripts/check-prereqs.py`.
