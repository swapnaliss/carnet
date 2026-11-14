---
title: "M4-05 · Judge replay mode, demo reset, per-session caps"
milestone: "M4 · Governance & Evals"
labels: ["frontend"]
blocked_by: ["M3-GATE"]
estimate: "6h"
resources: []
needs: ["P-10"]
---

## Context

R4 and R9: judges must be able to open a working demo without our sandbox account, our model credits or our single open-RFI slot being consumed by strangers ([ADR 0018](../../docs/adr/0018-sandbox-simulator-and-replay-mode.md): judge access is a replay of a recorded real run, clearly labelled as a recording; no mock path in the product). Risks: only one TRANSACTION RFI can be open in the sandbox (judges colliding), credit drain from the $100 grant, and abuse of an open upload form. `CLAUDE.md` data policy: the judge login serves a labelled replay of a recorded real run; fixtures were captured in M2-09 and M3-07.

This ticket builds to `docs/design/` and must pass the independent `ui-reviewer` design review.

## Scope

1. **Judge login.** A seeded, read-only user with role `judge` (credentials delivered through the README/submission form, never committed; the seed reads the password from an env key named `SEED_JUDGE_PASSWORD` and the script refuses to run without it). Server-side authorisation: the role can read the replay screens and nothing else; every mutating route (approvals, executions, uploads to live storage, flag toggles, Airwallex calls) returns 403 for it, tested.
2. **Replay engine.** Replay serves the recorded real run from the fixtures captured in M2-09 and M3-07 (webhook events, Airwallex responses, model outputs, agent steps, approvals, plan revisions, audit entries) as an ordered timeline the judge steps through (play, step, pause, restart). It drives the same screens (queue, hold screen, plan, payee page, `/ops` read-only) from a replay data source behind the existing repository/port interfaces, not from hard-coded UI. Nothing is faked: every displayed value comes from the recording; the recording's capture date, commit and model ids are shown. No Airwallex or model call is made in replay (asserted).
3. **Labelling.** A persistent banner on every replay screen: "Recording of a real sandbox run on <date>. Nothing here is live." with a link to what is real. Banner is not dismissible, has an accessible name, and is present in the page title and in the payee page view. Strings come from the typed strings module.
4. **Live mode.** Only the owner's login can switch to live (the real sandbox and model). The mode is a server-side session attribute, not a client flag; a judge cannot reach live by URL or request tampering (tested).
5. **Per-session caps** (config values with these defaults): upload cap per session 5 MB per file (`UPLOAD_MAX_BYTES`) and 10 files per session; model spend per session capped by `SESSION_MODEL_CAP_USD`, checked through the M4-02 spend guard in addition to the per-run and daily caps. Exceeding a cap gives a clear message and a `429`/`413`, with no partial work. Counters are in the DB keyed by session, not in memory.
6. **Demo reset.** `scripts/demo-reset.ts` (npm script `demo:reset`) restores the seeded state idempotently: businesses, users (judge and owner, no secrets printed), documents, obligations, payments, policy, flags, replay recording index. Running it twice leaves the same state (checksum of the seeded tables is identical). It refuses to run against a database that is not marked as the demo database and prints what it will delete before doing so (`--yes` to proceed non-interactively). It preserves the audit chain's validity (appends a reset event; it does not truncate `audit_log` since the app role cannot) and is documented in the README setup section text prepared for M5-01.

## Out of scope

- Recording new real runs (done in M2-09 and M3-07; if the recording is missing a screen state, log to `BL-01` and block on the owning ticket).
- A public sign-up or multiple judge accounts.
- Client-side only replay (it must be server-authorised).
- Accessibility and Core Web Vitals tuning (M4-07).

## Acceptance Criteria

- [ ] A judge session can walk the full replay (storyboard steps 1-5 and the revised plan) and sees the recording banner on every screen (Playwright asserts banner text on each route)
- [ ] During a replay, a network spy records zero requests to Airwallex hosts and zero model API requests
- [ ] Every mutating route returns 403 for the judge role (route table test enumerates all mutating routes and fails if a new one is not covered)
- [ ] Switching to live as the judge (cookie/URL/header tampering) is refused; the owner can switch and a visible LIVE indicator replaces the recording banner
- [ ] Uploading a file above the cap, an 11th file, and a model call over `SESSION_MODEL_CAP_USD` are each refused with the documented status and message, and counters survive a server restart
- [ ] `npm run demo:reset -- --yes` run twice produces an identical seeded-table checksum; run against a non-demo database it exits non-zero and changes nothing; `verifyAuditChain` stays OK after reset
- [ ] `ui-reviewer` design review passes against `docs/design/` (replay controls, banner, loading/empty/error states, keyboard operation)
- [ ] `./scripts/landing-checks.sh` passes

## Deliverables

- Replay data source and timeline controls in `apps/web`; judge role in auth seed; session caps module in `packages/db`/`apps/web`
- `scripts/demo-reset.ts`, `demo:reset` npm script
- Playwright tests `apps/web/e2e/replay.spec.ts`, unit tests for caps and reset
- Strings entries; setup text for the README author (in the PR description, M5-01 places it)

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"
docker compose up -d postgres
npm run db:migrate
export SEED_JUDGE_PASSWORD="$(head -c 18 /dev/urandom | base64)"   # throwaway local value, never recorded
npm run demo:reset -- --yes
npm run db:checksum > "$TMPDIR/seed1.txt"
npm run demo:reset -- --yes
npm run db:checksum > "$TMPDIR/seed2.txt"
diff "$TMPDIR/seed1.txt" "$TMPDIR/seed2.txt"
! DATABASE_URL="postgres://x@localhost:1/notdemo" npm run demo:reset -- --yes
npx vitest run apps/web/test/session-caps.test.ts apps/web/test/judge-authz.test.ts
npx playwright test apps/web/e2e/replay.spec.ts
./scripts/landing-checks.sh
```

## Handoff → M4-07, M4-GATE, M5-01, M5-02

Comment on the issue: judge login routes, the env keys (`SEED_JUDGE_PASSWORD`, `SESSION_MODEL_CAP_USD`, `UPLOAD_MAX_BYTES`; names only), the demo reset command and its guarantees, and the recording's capture date. M4-07 runs accessibility and Web Vitals over the replay routes; M5-01 documents the judge path and reset; M5-02 films from replay as a fallback.
