# ADR 0007: Persisted execution attempts; lookup before retry

Status: accepted (2 Nov 2026)

## Context
A timeout or crash after Airwallex accepts a request must not lead to a second payment.

## Decision
Before any transfer, conversion or RFI response, an `ExecutionAttempt` with its `request_id` is written in the same transaction that consumes the approval. After a timeout or 5xx the attempt becomes UNKNOWN; the reconciler resolves it by looking the object up (by `request_id` or by fetching the RFI). A new `request_id` is never minted for the same intent. An RFI already ANSWERED means the response is treated as done.

## Alternatives considered
Retrying with a new id (double payment); treating a timeout as failure.

## Consequences
Cost to reverse: low.
