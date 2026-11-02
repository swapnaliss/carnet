# ADR 0006: Payment status is a projection of the transfer and the RFI

Status: accepted (2 Nov 2026)

## Context
Airwallex reports eleven transfer statuses, an RFI can arrive while a transfer is SCHEDULED, PROCESSING or SENT, and events arrive out of order.

## Decision
`project(transferStatus, openRfi)` is a total function over all eleven statuses; 'held' is a flag. RFI events never set SENT, PAID or FAILED. A stale event is ignored when its `updated_at` or status rank is older than the stored one. PAID to FAILED raises an incident. The table is tested with permuted event orders.

## Alternatives considered
A hand-written status machine with its own transitions (drifts from the provider's truth).

## Consequences
Cost to reverse: medium.
