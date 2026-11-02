# ADR 0001: Modular monolith with npm workspaces

Status: accepted (2 Nov 2026)

## Context
Carnet has one team (one person), one deployable and a domain that must stay free of I/O so money and approval logic is testable in isolation. The load is 0.17 requests/s at 100x.

## Decision
One deployable. npm workspaces: `packages/domain` (pure TypeScript: money, state machines, planner, policy, evidence rules, approval hashing; imports no framework or I/O), `packages/db` (schema, migrations, repositories, outbox), `packages/airwallex` (REST client, webhook verification, simulation port), `packages/agent` (model adapter, prompts, verifier, evals), `apps/web` (UI, route handlers, worker entry). Dependencies point inward to `domain`.

## Alternatives considered
Microservices (no separate scaling or failure profile); a single flat package (boundaries would be unenforced); turbo or pnpm (not needed; pnpm is not installed).

## Consequences
Cost to reverse: low. Boundaries are enforced by package dependencies and a lint rule on `domain` imports.
