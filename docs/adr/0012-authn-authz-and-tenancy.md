# ADR 0012: Authentication, authorization and tenancy

Status: accepted (2 Nov 2026)

## Context
The product has users and holds approvals; judges also need access.

## Decision
better-auth with email and password sessions. Roles owner, approver, viewer. Every repository call takes a context with `business_id`; authorisation is enforced server-side. A seeded read-only judge login serves a labelled replay of a recorded real sandbox run. Per-session upload and model-spend caps apply. Rate limits on login, approval and webhook routes use a database counter. Secrets live in the platform environment and `.env`.

## Alternatives considered
A hosted identity provider (extra account); row-level security (per-transaction settings do not fit pooled connections at this size).

## Consequences
Cost to reverse: medium.
