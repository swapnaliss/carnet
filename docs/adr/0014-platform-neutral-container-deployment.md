# ADR 0014: Platform-neutral container deployment

Status: accepted (2 Nov 2026)

## Context
The hosting platform (Railway, Render, or AWS if credits are granted) is not decided; the Airwallex webhook needs a stable public URL early.

## Decision
Ship one Docker image (Next.js standalone output) that runs in `web` or `worker` mode. The contract with any platform: a container, `DATABASE_URL`, environment variables, a public HTTPS URL, `/healthz`, a restart policy and at least one always-on worker. The platform is chosen in an owner-decision ticket in the first milestone; its backup, region, idle-sleep and cost behaviour are verified there. Local development uses Docker Postgres and polling, with an optional tunnel for webhooks.

## Alternatives considered
Committing to one platform now; serverless-only deployment (hosts a worker poorly).

## Consequences
Cost to reverse: low.
