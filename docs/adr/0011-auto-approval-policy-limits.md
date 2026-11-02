# ADR 0011: Bounded autonomy for FX conversions

Status: accepted (2 Nov 2026)

## Context
Autonomy must be visible and bounded, and an auto-approved action must still leave a record of the policy that allowed it.

## Decision
RFI answers and payouts always need a person. An FX conversion may auto-execute only when it is within the reserve floor, under a per-action limit and a cumulative daily cap, within a slippage bound against the approved indicative rate, using a fresh quote at execution. Each auto-approval is stored with the policy version and hash. Contract-derived criticality is a proposal; the owner confirms it before the planner uses it.

## Alternatives considered
Always ask (no autonomy to show); unlimited auto-execution.

## Consequences
Cost to reverse: low.
