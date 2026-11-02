# ADR 0016: TypeScript 5.9.3 and exact version pins

Status: accepted (2 Nov 2026)

## Context
TypeScript 7.0.2, Vitest 5, Next 16 and the Anthropic SDK 1.x are new majors; a 13-day solo build cannot absorb toolchain breakage.

## Decision
TypeScript 5.9.3 as the default; exact pins and a lockfile for every dependency, verified against the registry on the day (Next 16.4.3, React 19.3.1, Tailwind 4.3.3, Drizzle 0.45.4, drizzle-kit 0.31.11, zod 4.6.7, Anthropic SDK 1.3.0, better-auth 1.7.15, Vitest 5.0.5, Playwright 1.64.1, pino 10.4.0, pg 8.23.1, pdfkit 0.20.2, unpdf 2.1.0, Biome 2.6.4). Revisit TypeScript 7 after the build.

## Alternatives considered
TypeScript 7.0.2; Drizzle 1.0 release candidate; unmaintained pdf-lib.

## Consequences
Cost to reverse: low.
