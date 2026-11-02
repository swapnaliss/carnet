# ADR 0002: PostgreSQL system of record; money as integer minor units

Status: accepted (2 Nov 2026)

## Context
Payments, approvals and idempotency need transactions and strong consistency. The hosting platform is chosen later (see ADR 0014), so the database must be portable.

## Decision
PostgreSQL for every entity, accessed through a plain `DATABASE_URL` with the `pg` driver and Drizzle ORM; migrations with drizzle-kit. Money is `bigint` minor units plus an ISO currency with an exponent table; decimal strings exist only at the Airwallex boundary. Consistency over availability for money, approvals and attempts (single primary); UI reads may lag by one poll interval.

## Alternatives considered
A document store (fluid schema is not needed); a vendor-specific serverless driver (ties the choice to one provider); floating-point or decimal columns for money.

## Consequences
Cost to reverse: medium (data migration).
