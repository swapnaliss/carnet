# ADR 0015: Logs, run tables and database-backed SLOs

Status: accepted (2 Nov 2026)

## Context
The core flow has latency and correctness SLOs, and the platform's log retention is unknown.

## Decision
pino JSON logs to stdout with correlation ids (request, event, RFI, run). Agent runs and steps are stored with tokens, cost, latency and prompt version. A `/ops` page computes SLOs from database timestamps. An optional scheduled GitHub Actions check calls the deployed health endpoint.

## Alternatives considered
A tracing or LLM-observability service (extra account for one deployable).

## Consequences
Cost to reverse: low.
