# ADR 0019: Hosting platform is Render

Status: accepted (3 Nov 2026), decided by the owner in M0-07

## Context
ADR 0014 left the platform open: Railway, Render, or AWS if the organisers grant credits. The organiser answer on AWS credits (P-12) is still outstanding; the owner chose to proceed without it because the Airwallex webhook needs a stable public URL now. The comparison, with a source and date per cell, is in `docs/budget.md` (Hosting). Several paid prices could not be fetched and are marked unverified there.

## Decision
Host on Render, region Singapore, using the M0-02 Dockerfile (`PROCESS_MODE=web` and `worker`), a Render Postgres instance on a paid plan with point-in-time recovery, and a paid background worker. The web service answers `/healthz` as the health check. The web service must not be a free instance (it sleeps after 15 minutes). The owner stated on 4 Nov 2026 that the Render account holds $50 of credits that cover hosting, so no cash is spent and the $40 cash ceiling in `docs/budget.md` is untouched. M1-06 checks the credit balance against the prices shown in the create form before creating the paid resources. Render needs GitHub access to the private repository for Git-backed builds (P-21); a prebuilt image from a registry is the alternative.

## Alternatives considered
Railway (usage-based pricing, comparable regions, Postgres as a template with backups); AWS (up to $200 credits for new accounts for 6 months, but more setup and its fit for a small worker is unverified); the Render free tier (sleeps, no worker, free Postgres has no backups and expires after 30 days).

## Consequences
Cost to reverse: low, because the container contract of ADR 0014 holds on any platform. If the organisers grant AWS credits, this ADR can be superseded without changing application code. Individual monthly prices are unverified; the cost is covered by the owner's $50 Render credits, and if the credits run short the decision returns to the owner.
