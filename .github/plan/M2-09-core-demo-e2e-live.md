---
title: "M2-09 · Core demo e2e live (storyboard steps 1–5)"
milestone: "M2 · Evidence to Answer"
labels: ["backend", "critical"]
blocked_by: ["M2-03", "M2-06", "M2-08"]
estimate: "5h"
resources: ["AIRWALLEX_SANDBOX", "ANTHROPIC", "DEPLOY"]
needs: []
---

## Context

R4 (demo arc) and R0: the claim "storyboard steps up to submission run for real" is only true once it runs in production against the real Airwallex sandbox and the real model. This ticket proves the core loop end to end, records it, and captures fixtures so every later check can replay it. It claims all three shared resources: the sandbox allows one open TRANSACTION RFI at a time and the deployed environment has one database and one webhook subscription, so nothing else may run against them meanwhile. Claims in the README and video may only cite what this run shows (CLAUDE.md claims discipline).

If the M0-04 spike showed that a plain account cannot create simulated RFIs, the RFI is injected locally in the documented webhook shape through the same signature verification, labelled "sandbox-injected" in the UI and recorded as such (ADR 0018); the run record states which path was used.

## Scope

Run in the **deployed** environment (M1-06), as the seeded owner:

1. Upload the dataset documents (`fixtures/dataset/`: invoices, a contract, a statement, the image-only and the injection document) through the UI.
2. Extraction completes with quotes verified; the image-only document needs owner confirmation and is confirmed; the injection document is flagged.
3. Evidence flags: the queue shows at least one Strong and one Weak payment as the dataset defines.
4. Create and send the payments (real sandbox transfers); the Weak one is sent only after the acknowledgement.
5. A real simulated TRANSACTION RFI (TEXT + ATTACHMENT questions, sources pointing at one transfer) is created through the `SandboxSimulator` port; the transfer shows HELD (flag) while its money status stays what the transfer says.
6. The webhook arrives (signature verified) → job → fetch → drafting with the real model → `DRAFT_READY` with verified citations; event-to-draft time recorded.
7. Approve on the hold screen → respond executes (attachments uploaded to the files host, respond with all questions) → RFI `ANSWERED` → the simulator closes the RFI → Carnet shows the RFI closed.
8. The transfer reaches `SENT`/`PAID` **on its own status** (via the sandbox transition simulation if needed); the run shows no payment status changed by an RFI event alone.
9. **Playwright e2e** `apps/web/e2e/core-demo.live.spec.ts` against `E2E_BASE_URL` (the deployed URL), runnable only when the live resources are free; plus a **replay-mode** variant using the captured fixtures that runs in CI without live calls.
10. **Recording**: `docs/evidence/m2-run.md` (tracked) with timestamps per step, request ids (no secrets, no tokens), measured SLO numbers (webhook ack, event-to-draft, approval-to-answered), model cost and tokens, which path created the RFI, and anything that deviated; screenshots under `docs/evidence/m2-run/` (synthetic data only).
11. **Fixtures captured**: real Airwallex responses and webhooks for this flow into `fixtures/airwallex/m2-run/`, model responses into `fixtures/anthropic/m2-run/`, with secrets and account identifiers scrubbed by the existing scrub script and checked by `check-no-secrets.sh`.
12. Problems found are fixed in the owning ticket's area when small, otherwise logged with `/backlog`; nothing is hidden in the run record.

## Out of scope

- Planner, conversions, payouts, follow-up round, payee page (M3)
- Judge replay mode UI (M4-05); load testing (M4-06)

## Acceptance Criteria

- [ ] The live Playwright run passes against the deployed URL from a clean state (reset command documented) and finishes in one session
- [ ] `docs/evidence/m2-run.md` lists every step 1–8 with a timestamp, the RFI id, the transfer id and final transfer status, the model cost, and the RFI creation path
- [ ] The RFI in the run reached `ANSWERED` through a respond whose body contained every question, with an uploaded attachment, and the attempt row shows `CONFIRMED`
- [ ] The held payment's money status was never set by an RFI event (query of status history in the record)
- [ ] Measured: webhook ack, event-to-draft and approval-to-answered times are in the record; each is compared with the SLO in architecture §9 and any miss is stated
- [ ] Screenshots exist for queue with flags, evidence view, hold screen with snippets, approval, answered state
- [ ] Replay variant: `E2E_MODE=replay` passes in CI using only `fixtures/`, no network
- [ ] Total model spend of the run is within `MODEL_PER_RUN_CAP_USD` and recorded; daily cap untouched by more than the run
- [ ] `./scripts/check-no-secrets.sh` passes over the new fixtures and evidence files

## Deliverables

- `apps/web/e2e/core-demo.live.spec.ts`, `apps/web/e2e/core-demo.replay.spec.ts`
- `docs/evidence/m2-run.md`, `docs/evidence/m2-run/*.png`
- `fixtures/airwallex/m2-run/`, `fixtures/anthropic/m2-run/`
- `scripts/demo-reset.sh` (idempotent reset of the demo business in the target environment, documented)

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; T="$(mktemp -d "$TMPDIR/m2-09.XXXXXX")"
test -s docs/evidence/m2-run.md
ls docs/evidence/m2-run/*.png | wc -l | awk '{exit !($1>=5)}'
grep -q "ANSWERED" docs/evidence/m2-run.md
grep -q "CONFIRMED" docs/evidence/m2-run.md
E2E_MODE=replay npx playwright test apps/web/e2e/core-demo.replay.spec.ts --reporter=json > "$T/replay.json"
jq -e '.stats.unexpected == 0' "$T/replay.json"
./scripts/check-no-secrets.sh
# live proof (claims AIRWALLEX_SANDBOX, ANTHROPIC, DEPLOY): 
#   E2E_BASE_URL=<deployed url> npx playwright test apps/web/e2e/core-demo.live.spec.ts
```

## Handoff → M2-GATE, M3-07, M4-05, M5-02

The gate checks the run record and replays; M3-07 extends this flow to the full storyboard; M4-05 serves the recording as the judge replay; M5-02 takes screenshots and timings for the video. Post an issue comment with the run date, RFI creation path, measured times, model cost and the fixture directories.
