# Toolchain evidence (M0-02, 2 Nov 2026)

Every version below was checked with `npm view <pkg>@<version> version` on 2 Nov 2026 and resolved.
`npm audit --omit=dev`: 0 vulnerabilities. No pin had to change (ADR 0016).

| Package | Version | Installed in | Verified |
|---|---|---|---|
| typescript | 5.9.3 | root (dev) | 2026-11-02 |
| vitest | 5.0.5 | root (dev) | 2026-11-02 |
| @biomejs/biome | 2.6.4 | root (dev) | 2026-11-02 |
| @playwright/test | 1.64.1 | root (dev) | 2026-11-02 |
| pdfkit | 0.20.2 | root (dev) | 2026-11-02 |
| @types/node | 24.19.2 (24 line) | root (dev) | 2026-11-02 |
| next | 16.4.3 | @carnet/web | 2026-11-02 |
| react, react-dom | 19.3.1 | @carnet/web | 2026-11-02 |
| @types/react, @types/react-dom | 19.3.0 | @carnet/web (dev) | 2026-11-02 |
| drizzle-orm | 0.45.4 | @carnet/db | 2026-11-02 |
| pg | 8.23.1 | @carnet/db | 2026-11-02 |
| drizzle-kit | 0.31.11 | @carnet/db (dev) | 2026-11-02 |
| @types/pg | 8.23.1 | @carnet/db (dev) | 2026-11-02 |
| @anthropic-ai/sdk | 1.3.0 | @carnet/agent | 2026-11-02 |
| zod | 4.6.7 | @carnet/agent, @carnet/domain | 2026-11-02 |
| unpdf | 2.1.0 | @carnet/agent | 2026-11-02 |
| tailwindcss, @tailwindcss/postcss | 4.3.3 | not installed (M1-07) | 2026-11-02 |
| better-auth | 1.7.15 | not installed (M1-04) | 2026-11-02 |
| pino | 10.4.0 | not installed (M1-09) | 2026-11-02 |

Runtime: Node 24.22.1, npm 11.19.1 (`.nvmrc` 24; `engines` node >=24 <25).
Actions pinned by commit SHA: actions/checkout v7.0.1, actions/setup-node v7.1.0, gitleaks/gitleaks-action v3.0.0.

## Measured timings
| Measure | Result | Budget |
|---|---|---|
| Fresh clone: `npm ci` + typecheck + lint + test | 25 s | 120 s |
| `make reset` (volume dropped, Postgres healthy) | 4 s warm (24 s the first time, including the image pull) | 120 s |
| CI, warm cache (run [41435102497](https://github.com/swapnaliss/carnet/actions/runs/41435102497)) | 77 s whole run (check job 63 s, docker job 41 s) | 300 s |
| CI, first run (run [41434760844](https://github.com/swapnaliss/carnet/actions/runs/41434760844)) | check job 63 s, docker job 40 s | 300 s |
| Docker image, `web` mode | 298 MB, runs as uid 1000, no `.env` inside | - |

## Proofs
- Architecture guards: a throwaway `import { Pool } from "pg"` in `packages/domain/src` made `./scripts/landing-checks.sh` exit 1 ("packages/domain must not import frameworks, SDKs or I/O"); a throwaway `import "@carnet/airwallex"` in `packages/agent/src` made it exit 1 (`check-deps`: dependency direction violated). Both reverted.
- gitleaks: a planted fake GitHub token on branch `tmp/gitleaks-probe` failed the CI `gitleaks` step (run 41434957056); branch deleted.
- Worker: `PROCESS_MODE=worker` started, logged a heartbeat and exited 0 on SIGTERM.

## Notes
- Worker runs with Node's built-in type stripping (`node worker.ts`), so it must stay erasable TypeScript (`erasableSyntaxOnly` is on) and cannot yet import workspace packages; M1-05 decides whether to bundle it.
- esbuild install scripts are not approved under npm 11's `allowScripts`; the toolchain (Vitest, drizzle-kit) works without them.
