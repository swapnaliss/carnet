# ADR 0013: Hash-chained append-only audit log

Status: accepted (2 Nov 2026)

## Context
A trigger that blocks updates can be removed by the owning role.

## Decision
Each audit row stores `prev_hash` and `hash`. The chain is verified on `/ops`. The application connects with a role that cannot alter or drop the table, its trigger, or truncate it; a separate migration role owns the schema.

## Alternatives considered
A trigger only; an external ledger service.

## Consequences
Cost to reverse: low.
