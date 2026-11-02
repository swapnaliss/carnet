---
title: "M0-02 · Repo bootstrap: workspaces, TS 5.9.3, biome, vitest, CI with caching, gitleaks, licence, Docker, `make up/down`, toolchain smoke"
milestone: "M0 · Recon & Bootstrap"
labels: ["infra"]
blocked_by: ["M0-00"]
estimate: "6h"
resources: []
needs: ["P-01", "P-02", "P-08", "P-09", "P-19"]
---

## Context

Every later ticket lands through `scripts/landing-checks.sh`, which calls the root `typecheck`, `lint` and `test` scripts. They do not exist yet. PROJECT.md §10 lists "New majors in the toolchain" (lost days) and "Public repo leaks a secret"; ADR 0016 pins TypeScript 5.9.3 and exact versions, ADR 0014 requires one Docker image that runs in `web` or `worker` mode, ADR 0001 sets the workspace layout. This ticket makes the feedback loop fast enough to be used (rubric R9: public repo with setup instructions; R5/R7 depend on the packages existing).

## Scope

1. **Workspaces** (npm 11, no pnpm/turbo): `packages/domain`, `packages/db`, `packages/airwallex`, `packages/agent`, `apps/web`, as in ADR 0001, named `@carnet/domain`, `@carnet/db`, `@carnet/airwallex`, `@carnet/agent` and `@carnet/web` (the landing checks in `scripts/landing-checks.sh` rely on these names and on the paths `packages/domain/src` and `packages/agent/src`). Each package: `package.json`, `tsconfig.json` extending a root `tsconfig.base.json`, one trivial exported function and one Vitest test so the pipeline is exercised. Enforce the ADR 0001 dependency direction with a lint rule or a small check (domain imports nothing from other packages).
2. **Exact pins, verified today**: re-check every version in PROJECT.md §4 and ADR 0016 with `npm view <pkg> version` and `npm view <pkg>@<version> version` the day this ticket runs; do not trust the table. Install with `--save-exact`, commit `package-lock.json`, `.npmrc` with `save-exact=true`. Record the verified list (package, version, date) in `docs/evidence/toolchain.md`. If a pinned version no longer resolves or a security advisory (`npm audit --omit=dev`) is high, stop and note it on the issue instead of switching major lines (ADR 0016).
3. **Root scripts**: `typecheck` (`tsc --noEmit` per workspace), `lint` (Biome check), `format`, `test` (Vitest run), `build`. `.nvmrc` with the Node 24 line; `engines` in the root `package.json`.
4. **Biome 2.6.4** config, **Vitest** config (unit project now, integration project that needs `TEST_DATABASE_URL`, skipped with a clear message when absent).
5. **Docker**: multi-stage `Dockerfile` (deps, build, runtime) producing the Next.js standalone image; entrypoint reads `PROCESS_MODE=web|worker`; the worker mode is a skeleton loop that logs and exits cleanly on SIGTERM. Non-root user, `.dockerignore`. `GET /healthz` in `apps/web` returns 200 JSON.
6. **Local stack**: `docker-compose.yml` with `postgres:17-alpine`, healthcheck, named volume; `Makefile` with `up`, `down`, `reset` (drop volume, recreate, run migrations once they exist; a no-op migration step now), and `check`.
7. **GitHub Actions CI** `.github/workflows/ci.yml`: npm cache, gitleaks, `biome`, `tsc`, `vitest` with a Postgres 17 service, `next build`; Docker build job (no push). Actions pinned by commit SHA or exact version.
8. **Licence** already present: confirm `LICENSE` and the `license` field agree.
9. **Toolchain smoke**: `next build`, `drizzle-kit generate` against a one-table throwaway schema in `packages/db` (kept as the first real schema stub only if ADR 0002 allows; otherwise deleted after the smoke), `vitest run`. Scripted as `scripts/toolchain-smoke.sh`, reused by M0-GATE.
10. **Feedback-loop budgets are measured, not assumed**: record wall-clock for local check, CI and reset in `docs/evidence/toolchain.md`.

## Out of scope

- Real schema, migrations, or business code (M1)
- Deploying to a host (M1-06) and choosing it (M0-07)
- Playwright setup beyond the pinned install check; Tailwind/shadcn theming (M1-07)
- Any Airwallex or Anthropic call

## Acceptance Criteria

- [ ] `npm ci && npm run typecheck && npm run lint && npm test` passes from a fresh clone and the whole local check takes at most 2 minutes (time recorded)
- [ ] `./scripts/landing-checks.sh` passes end to end
- [ ] The landing checks' architecture guards are proven: a throwaway import of `pg` inside `packages/domain/src` and of `@carnet/airwallex` inside `packages/agent/src` each make `./scripts/landing-checks.sh` fail (shown once, then reverted)
- [ ] CI is green on a pushed branch and completes in at most 5 minutes with a warm cache (run URL and duration recorded)
- [ ] `make reset` (drops the Postgres volume and brings it back healthy) completes in at most 2 minutes
- [ ] `make up` then `curl -fsS localhost:<port>/healthz` answers from the built image in `web` mode; `PROCESS_MODE=worker` starts and stops cleanly on SIGTERM
- [ ] `scripts/toolchain-smoke.sh` runs `next build`, `drizzle-kit generate` and `vitest run` and exits 0
- [ ] Every dependency is an exact version (no `^` or `~`) and matches the versions verified today in `docs/evidence/toolchain.md`
- [ ] CI contains a gitleaks step that fails on a planted fake secret (shown once on a throwaway branch, then removed)

## Deliverables

- Root `package.json`, `package-lock.json`, `.nvmrc`, `.npmrc`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`
- `packages/{domain,db,airwallex,agent}/`, `apps/web/` skeletons
- `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `Makefile`
- `.github/workflows/ci.yml`
- `scripts/toolchain-smoke.sh`
- `docs/evidence/toolchain.md` (versions verified, measured timings)

## Validation Gate

```bash
set -euo pipefail
T="${TMPDIR:-/tmp}/m0-02"; rm -rf "$T"; mkdir -p "$T"
git clone -q . "$T/clone" && cd "$T/clone"
start=$(date +%s)
npm ci && npm run typecheck && npm run lint && npm test
elapsed=$(( $(date +%s) - start )); echo "local check ${elapsed}s"; [ "$elapsed" -le 120 ]
./scripts/landing-checks.sh
if grep -R -n -E '"[^"]+": *"[\^~]' package.json packages/*/package.json apps/*/package.json; then echo "unpinned dependency" >&2; exit 1; fi
test -f .nvmrc && test -f Dockerfile && test -f docker-compose.yml && test -f .github/workflows/ci.yml
grep -q gitleaks .github/workflows/ci.yml
start=$(date +%s); make reset; elapsed=$(( $(date +%s) - start )); echo "reset ${elapsed}s"; [ "$elapsed" -le 120 ]
./scripts/toolchain-smoke.sh
docker build -q -t carnet-m0-02 .
cid=$(docker run -d -p 3999:3000 -e PROCESS_MODE=web carnet-m0-02)
trap 'docker rm -f "$cid" >/dev/null' EXIT
for i in $(seq 1 30); do curl -fsS localhost:3999/healthz && break || sleep 1; done
curl -fsS localhost:3999/healthz
make down
```

## Handoff

- M0-03, M0-06 and M0-08 need the workspaces, `npm test`, and the script locations (`scripts/spikes/`, `fixtures/`).
- M0-GATE reruns `scripts/toolchain-smoke.sh` and `make reset`.
- M1-* tickets need `landing-checks.sh` green, the dependency-direction check, and `docs/evidence/toolchain.md`.
- Post on the issue: verified version table, the three measured timings, CI run link, and any pin that could not be kept.
