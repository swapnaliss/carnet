# ADR 0017: Next.js App Router, strings module and Intl

Status: accepted (2 Nov 2026)

## Context
The hero screen is data-heavy and stateful; accessibility and global readiness are requirements.

## Decision
Next.js App Router with server components for queue and plan pages and client components for the approval and hold screens. Tailwind 4 and shadcn with design tokens. Targets LCP < 2.5 s, INP < 200 ms, CLS < 0.1, WCAG 2.2 AA, with loading, empty and error states on every screen. No optimistic updates on money or approvals. Strings live in a typed module with `Intl` formatting for money and dates.

## Alternatives considered
A single-page app; next-intl routing for one locale.

## Consequences
Cost to reverse: low.
