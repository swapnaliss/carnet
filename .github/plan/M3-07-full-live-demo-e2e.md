---
title: "M3-07 · Full live demo e2e"
milestone: "M3 · Hold-Aware Planning"
labels: ["critical"]
blocked_by: ["M3-03", "M3-04", "M3-05", "M3-06"]
estimate: "5h"
resources: ["AIRWALLEX_SANDBOX", "ANTHROPIC", "DEPLOY"]
needs: ["P-03", "P-04", "P-05", "P-06", "P-10", "P-17"]
---

## Context

M2-09 ran storyboard steps 1 to 5 for real. This ticket runs the whole `PROJECT.md` §2 storyboard against the **deployed** product with the real sandbox and the real model, and records it: rubric R4 (demo arc), and the evidence behind R2, R3 and R8. It also captures the fixtures the judge replay mode (M4-05, ADR 0018) will serve, so the replay is a recording of a real run, labelled as such. Claims discipline: the README and video claim only what this run shows. Risks: one open Transaction RFI at a time (sequential demo, exclusive `AIRWALLEX_SANDBOX`), simulated RFIs possibly unavailable on a plain account (then the labelled injection through the same signature check per ADR 0018, disclosed in the evidence), held funds' balance behaviour (as measured by M0-04).

## Scope

Run, in order, on the deployed environment (exclusive `DEPLOY`, `AIRWALLEX_SANDBOX`; model spend within `MODEL_PER_RUN_CAP_USD`):

1. **Goal and plan**: owner logs in, states the goal ("payroll and two suppliers by Friday"), obligations exist with criticality confirmed by the owner (the M3-01 control), plan revision 1 shows.
2. **Evidence flags**: the payment queue shows evidence strength per payment, one weak (M2-03).
3. **Payments**: two payments clear, one is sent as real sandbox transfers.
4. **Hold**: a real Transaction RFI arrives on the sent transfer (simulated through the real `/simulation/rfis/create` where the M0-04 result allows; otherwise the labelled injection); webhook verified, payment shows HELD FOR INFORMATION, the plan re-runs to revision 2 without any RFI-derived money status.
5. **Drafts and approval**: cited drafts, source snippets, one bound approval, submit (M2 flow).
6. **Plan revised**: revision 2 executes: the conversion auto-executes under policy (AutoApproval row with policy version and hash), the alternate payout is approved by the owner on the plan screen and executes, the non-critical bill is deferred. The balances are re-read at execution.
7. **Transfer outcome on its own status**: the held transfer reaches SENT/PAID through the transfer's own status (simulated transition via the real `/simulation/transfers/{id}/transition`); the demo asserts the payment status did not change when the RFI was answered.
8. **Follow-up round**: a real `follow_up` reopens a question; round 2 reuses one approved answer in one click (a fresh bound approval) and drafts the changed one.
9. **Payee page**: an owner creates a link; open `/status/<token>` on the deployed host: GENERIC wording, then the opt-in wording while held.

Deliver:

- **Playwright e2e** `apps/web/e2e/demo-live.spec.ts` that drives steps 1-9 against `E2E_BASE_URL` with owner credentials taken from `E2E_OWNER_EMAIL` and `E2E_OWNER_PASSWORD` (env keys only), writing screenshots after each step.
- **Recorded run** `docs/evidence/m3-run.md` (tracked): timestamps, plan revisions and `inputs_hash`, RFI id, transfer ids, conversion id, attempt rows with `request_id`, AutoApproval policy version and hash, approval ids, model run ids with tokens and cost, event-to-draft latency, and every deviation or UNVERIFIED item stated as such; screenshots saved under `docs/evidence/m3/` and linked.
- **Captured fixtures for replay mode** under `fixtures/replay/m3/`: the ordered webhook events, Airwallex responses and model outputs of this run (secrets and tokens scrubbed; verified by `./scripts/check-no-secrets.sh`), with a manifest stating the run date and "recording".
- A demo reset command documented in the run note (idempotent) so the run can be repeated; if any step fails, the failure is fixed in the owning code (not in the test) and the run repeated from a reset.

## Out of scope

- Judge replay mode, load tests, evals (M4); the README and video (M5).
- Using production keys, real money, real documents; contacting any payee.
- Changing planner, executor or UI behaviour except to fix defects the run exposes (those go to the owning ticket's code with a test, logged via `/backlog` if larger).

## Acceptance Criteria

- [ ] `demo-live.spec.ts` passes end to end against the deployed URL, covering steps 1-9, with a screenshot per step saved.
- [ ] `docs/evidence/m3-run.md` exists, lists the real sandbox ids for the transfer(s), RFI, conversion and payout, and shows plan revision 1 and 2 hashes.
- [ ] In the run, zero payments changed to SENT or PAID on an RFI event alone (query over the event log in the run note: money status changes are all preceded by a transfer event).
- [ ] The conversion has an AutoApproval row with policy version and hash; the payout has a consumed approval; both have CONFIRMED attempts with a single `request_id` each.
- [ ] Round 2 of the follow-up shows one reused answer with zero model calls for it, applied by one click and a new approval hash.
- [ ] `/status/<token>` on the deployed host returns the three required headers and shows only status wording; opt-in wording appears only while held.
- [ ] The measured event-to-draft latency is recorded (target p95 under 60 s from the run traces; a single run reports the observed value, not a p95 claim).
- [ ] `fixtures/replay/m3/` is non-empty, scrubbed, and `./scripts/check-no-secrets.sh` passes on the repository.
- [ ] Model cost for the run is recorded and within the caps; the evidence states whether the RFI was sandbox-simulated or labelled-injected.

## Deliverables

- `apps/web/e2e/demo-live.spec.ts`, `docs/evidence/m3-run.md`, `docs/evidence/m3/*.png`
- `fixtures/replay/m3/` and its manifest; reset script entry (documented in the run note)

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; OUT="$(mktemp -d "$TMPDIR/m3-07.XXXXXX")"
: "${E2E_BASE_URL:?set to the deployed URL}"
curl -fsS "$E2E_BASE_URL/healthz" >/dev/null
# live run: exclusive AIRWALLEX_SANDBOX and DEPLOY; reads credentials from .env / the environment, never printed
npx playwright test apps/web/e2e/demo-live.spec.ts --output "$OUT/pw" --reporter=list 2>&1 | tee "$OUT/e2e.log"
test -s docs/evidence/m3-run.md
test "$(ls docs/evidence/m3/*.png | wc -l)" -ge 9
test "$(find fixtures/replay/m3 -type f | wc -l)" -ge 5
grep -qE 'plan revision 2|inputs_hash' docs/evidence/m3-run.md
grep -q 'AutoApproval' docs/evidence/m3-run.md
./scripts/check-no-secrets.sh
./scripts/landing-checks.sh
```

## Handoff

- **M3-GATE** requires the evidence file, screenshots and fixtures present.
- **M4-05** serves `fixtures/replay/m3/` as the labelled judge replay; **M4-03** seeds eval traces from it; **M5-01** and **M5-02** quote `docs/evidence/m3-run.md` and use the screenshots.
Post as an issue comment: the run date, whether the RFI was simulated or injected, the sandbox ids, the model cost, the observed latencies, any step that deviated and how it was resolved, and the new env keys (`E2E_BASE_URL`, `E2E_OWNER_EMAIL`, `E2E_OWNER_PASSWORD`; names only).
