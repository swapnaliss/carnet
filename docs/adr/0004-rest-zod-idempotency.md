# ADR 0004: REST API with shared zod schemas

Status: accepted (2 Nov 2026)

## Context
Judges and tests need a documented, typed contract; the UI and the worker share validation.

## Decision
REST JSON under `/api/v1` implemented as Next.js route handlers. Request and response schemas are zod objects in `domain` and shared with the client. `Idempotency-Key` is stored for money and approval endpoints only. One error format, cursor pagination, rate limits on login, approval and webhook routes.

## Alternatives considered
GraphQL or tRPC (an extra layer for a small surface); Server Actions only (no documented contract).

## Consequences
Cost to reverse: low.
