# ADR 0003: Documents stored in PostgreSQL

Status: accepted (2 Nov 2026)

## Context
Documents are synthetic, at most 5 MB, a few hundred in total; a second store adds an account, a quota and a failure mode.

## Decision
Store bytes as `bytea` with a SHA-256, immutable. Upload cap 5 MB (config), PDF at most 20 pages, magic-byte validation. At 100x scale, documents move to object storage (trigger: database size or cost).

## Alternatives considered
Object storage now (extra service, quotas, cost); filesystem (not durable across container restarts).

## Consequences
Cost to reverse: medium (copy bytes, add a pointer column).
