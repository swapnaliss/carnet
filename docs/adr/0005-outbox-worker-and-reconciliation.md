# ADR 0005: Outbox jobs, a worker process and a reconcile poll

Status: accepted (2 Nov 2026)

## Context
Airwallex webhooks are at-least-once and unordered and can be missed; the webhook must be acknowledged quickly; load is 0.17 requests/s.

## Decision
The webhook route verifies the signature, stores the event and a job in one transaction and returns 200. A `worker` process (the same image) claims jobs with `SELECT ... FOR UPDATE SKIP LOCKED` every second, retries with backoff, marks jobs DEAD after the retry limit, and runs a reconcile job every 60 s that polls RFIs and open transfers and resolves UNKNOWN attempts. Handlers fetch the resource and never trust the payload status.

## Alternatives considered
A message broker or managed queue (no requirement forces it, and the database must be the source of truth anyway); a workflow engine (hides state that Carnet owns); in-request background work (no retries).

## Consequences
Cost to reverse: low; job handlers are plain functions.
