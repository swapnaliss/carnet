# M3-07 run record: the full demo, live (TEMPLATE, NOT YET RUN)

**Status: template.** No live run has happened. Every `TBD` below is filled from the real run (the spec's `docs/evidence/m3/run.json`, `docs/evidence/m3/airwallex/*.json`, and the database export), never written from memory or invented. Delete this paragraph when the run is recorded. Claims discipline: the README and video claim only what this file shows.

**What this is.** One real run of `PROJECT.md` §2 storyboard steps 1-9 against the deployed Carnet (`carnet-web`, `carnet-worker`; commit TBD), the real Airwallex sandbox and the real model. Synthetic data; the sandbox and model API are real. Run by the owner on TBD (UTC), started with `apps/web/e2e/demo-live.spec.ts`.

## How to run it (owner)

1. Reset: `./scripts/demo-reset.sh` (idempotent; adds the six dataset payees, never deletes; every run uses a fresh reference prefix `M3RUN-<yymmddhhmm>`, so "clean" means clean per run, as in M2-09). The spec needs nothing else reset.
2. Precondition: deployed `main` at or after 3d67376 (the production worker registers `plan.rerun` with a real loader, ADR 0021). Revision numbers are not fixed: every input change (obligation created, criticality confirmed, payment submitted, transfer status, RFI hold) queues a re-run and a revision is written only when `inputs_hash` changed, so the spec asserts on the newest plan once it stops changing, not on numbers.
3. Run (exclusive `AIRWALLEX_SANDBOX` and `DEPLOY`):
   `E2E_MODE=live E2E_BASE_URL=<deployed url> E2E_OWNER_PASSWORD=<owner password> node --env-file=.env node_modules/.bin/playwright test apps/web/e2e/demo-live.spec.ts --reporter=list`
   (`E2E_OWNER_EMAIL` defaults to `owner@carnet.example`; empty values count as unset.) Screenshots, `run.json` and `airwallex/*.json` land in `docs/evidence/m3/`.
4. Export what the API does not expose (needs the export job image to include the M3-07 tables, so deploy `main` with this PR first): `./scripts/demo-export.sh <run-start-iso> "$TMPDIR/m3-run.jsonl"`.
5. Capture the replay fixtures: `npx tsx scripts/demo-capture-m3.ts "$TMPDIR/m3-run.jsonl"` (writes `fixtures/replay/m3/` with `manifest.json`: kind `recording`, run date), then `./scripts/check-no-secrets.sh`.
6. Fill this file; commit it with `docs/evidence/m3/*.png` and `fixtures/replay/m3/`.
7. Repeat from step 1 after a failure; fix the cause in the owning code, not in the spec.

## Demo settings (stated, owner decisions on issue #40)

These are settings chosen for the demo, not observations.

- **Auto-FX policy, version 1** (stored by `scripts/demo-reset.sh` through `ensureDemoPolicy`, only when the demo business has no policy; never a second version, never an update): per-action conversion limit USD 5,000.00, daily cap USD 10,000.00, USD reserve floor USD 100.00, slippage 100 bps, quote freshness 300 s. Policy hash as stored: TBD.
- **Payroll in SGD**: payee "Lion City Payroll Pte. Ltd." (synthetic, SG), SGD 1,500.00 due next Friday, criticality 1. The sandbox holds no SGD (EUR ~10,000,471 made EUR payroll a non-event), so payroll is a real shortfall the planner covers with a USD to SGD conversion. The demo only funds payroll; it never pays the payee, so the payee has no bank details or Airwallex beneficiary.
- **Order of approvals**: the alternate payout is approved on the plan screen in step 4, while the payment is held. Once the RFI is answered it no longer holds the payment and the next re-run drops the payout, so approving it after step 5 is not possible.
- **Conversion source**: when several currencies can cover a shortfall, the planner tries first those the policy can auto-approve, then the rest alphabetically (ADR 0021 amendment 1). With the demo policy (USD only) the SGD shortfall sells USD although the sandbox also holds CNY.
- **Deferral: not shown by this live run.** The sandbox account holds about 10 million in each of several currencies, so the live run had no cash shortfall the planner could not convert, and nothing was deferred. The spec records `deferred_in_run` (expected empty) and asserts nothing about it. Deferral of a non-critical bill is proven elsewhere, not by this run:
  - `packages/domain/src/planner/scenarios.test.ts`: "payroll Friday with one held payment: convert, fund payroll, alternate payout, defer the bill" (pure planner, fixtures/planner/payroll-friday.json);
  - `packages/domain/src/planner/planner.property.test.ts`: "property generator reaches every action kind and the unconfirmed and floor paths" and "more cash never turns a fund into a defer or escalate";
  - `apps/web/test/plans/plan-approve.int.test.ts`: "shows the revision pair: held funds unavailable, the four actions, fates, a verified explanation" (stored revisions, the plan read model);
  - `apps/web/e2e/plan-screen.spec.ts` (CI replay job): "the payroll-Friday pair: held funds unavailable, before and after, convert, fund, payout, defer" (the plan screen shows the defer card).
  The README and video must not claim a live deferral.

## Repeatability

The demo business keeps every earlier run (reset is add-only). The weak flag therefore comes from an amount mismatch, not from "first payment, no contract" (which only applies when there are no earlier payments to the payee; found in the first live attempt). Obligations of earlier runs are still owed and appear in the plan: the spec records `obligations_from_earlier_runs` and `sgd_obligations_from_earlier_runs` in step 1; state them here: TBD. An earlier run's SGD obligation whose conversion executed is funded by the SGD that conversion bought, so a new run then converts roughly its own SGD 1,500.00 (inferred from plan.ts, not observed).

## Run facts

| Field | Value |
|---|---|
| Run date and start/end (UTC) | TBD |
| Deployed commit (`/healthz` version) | TBD |
| Run prefix | TBD |
| RFI creation path (sandbox-simulated via `/simulation/rfis/create`, or labelled injection) | TBD (state which; if injected, say why) |
| Model spend for the run (USD) and cap `MODEL_PER_RUN_CAP_USD` | TBD |

## Steps 1-9

| # | Step | Time (UTC) | Result and ids |
|---|---|---|---|
| 1 | Goal (SGD payroll and two USD suppliers by Friday), obligations, criticality confirmed by the owner, the first plan (policy version 1) | TBD | obligation ids, confirmed criticality and proposal id, the plan for the goal (funds the obligations): revision and `inputs_hash` TBD |
| 2 | Evidence flags in the queue, one not strong | TBD | flags TBD. The Lakeside payment (USD 1,250.00) is weak because its amount differs from the invoice (USD 1,320.50), so it does not depend on history |
| 3 | Two payments cleared, sent as real sandbox transfers | TBD | transfer ids TBD; the sends create their own revision (the obligations leave the plan): revision, `inputs_hash`, action kinds (expected none) TBD |
| 4 | Hold: Transaction RFI on the sent transfer, webhook verified, payment held, re-plan | TBD | RFI Airwallex id TBD, Carnet id TBD; webhook `rfi.action_required` received TBD; plan after the hold: revision, `inputs_hash`, trigger `held`, payout action with reason `PAYOUT_ALTERNATE_FOR_HELD` TBD |
| 5 | Cited drafts, source snippets, one bound approval, submit | TBD | draft id, approval id and hash TBD, attempt `request_id` TBD |
| 6 | Execution: USD to SGD conversion auto-executed under policy; the payout approved in step 4 executed | TBD | conversion plan revision and action id, sell USD / buy SGD amounts, Airwallex conversion id TBD; payout action id and transfer id TBD; deferrals seen in the run (expected none: no shortfall at these balances; see Demo settings) TBD |
| 7 | Transfer reaches SENT then PAID on its own status | TBD | transfer id TBD; status while RFI answered TBD |
| 8 | Follow-up round: reopen one question, one reused answer, one drafted | TBD | reopened question TBD, new approval hash TBD |
| 9 | Payee page: GENERIC, then opt-in while held | TBD | wording read while held, headers, wording after paid TBD |

## Plan revisions

| Revision | `inputs_hash` | `content_hash` | Trigger |
|---|---|---|---|
| after the goal (step 1) | TBD | TBD | first |
| after the sends (step 3) | TBD | TBD | inputs changed |
| after the hold (step 4) | TBD | TBD | held (alternate payout) |
| after execution (step 6), if it differs | TBD | TBD | TBD |

## Money status was never set by an RFI event (AC 3)

Query over the exported event log: for every payment, each change of `transfer_status` is preceded by an `airwallex.transfer.*` / `payout.transfer.*` webhook for that transfer. Paste the query and its output here: TBD. Count of payments that became SENT or PAID on an RFI event alone: TBD (must be 0).

## Conversion and payout (AC 4)

| Item | Value |
|---|---|
| Conversion (USD to SGD): plan revision, action id, sell and buy amounts, Airwallex conversion id | TBD |
| AutoApproval row id, policy version, policy hash | TBD |
| Conversion attempt: id, `request_id` (one), status | TBD (CONFIRMED) |
| Payout: approval id, status (CONSUMED) | TBD |
| Payout attempt: id, `request_id` (one), status | TBD (CONFIRMED) |
| Payout Airwallex transfer id | TBD |
| Balances re-read at execution (before/after) | TBD |

## Follow-up round (AC 5)

Reused answer count, model calls made for the reused answer (from `agent_steps`; must be 0), applied by one click (yes/no), round 1 and round 2 approval hashes (must differ): TBD.

## Payee page (AC 6)

Required headers observed (`referrer-policy: no-referrer`, `x-robots-tag` with `noindex`, `cache-control: no-store`, `x-content-type-options: nosniff`): TBD. GENERIC wording while held: TBD. Opt-in wording while held and PROCESSING: TBD. Wording after the transfer is PAID: TBD. The opt-in wording can only show while the transfer is SCHEDULED or PROCESSING and an RFI holds the payment (`payeeStatus`), which is why the spec reads it in step 4 and again after PAID in step 9.

## Latency and SLOs (AC 7)

Event-to-draft latency observed (`rfi.action_required` received to draft stored): TBD s (a single run reports the observed value, not a p95). Approval to answered: TBD s. Webhook acknowledgement (n webhooks): TBD.

## Model runs and cost (AC 9)

| Run id | Kind | Model | Input / output tokens | Cost (USD) |
|---|---|---|---|---|
| TBD | | | | |

Total TBD USD; per-run cap TBD; daily cap TBD.

## Deviations and UNVERIFIED items

List every deviation (a step retried, an RFI question the model declined and the owner wrote, a sandbox behaviour that differed) and everything not verified. TBD. Known going in: the sandbox returns `usage: MULTI_USE` on quotes (M0-03); production behaviour is unverified; held-funds balance behaviour is as measured by M0-04.

## Files

- Screenshots: `docs/evidence/m3/01-goal-and-plan.png` ... `09c-*.png` (one per step, several for steps 6 and 9).
- `docs/evidence/m3/run.json`, `docs/evidence/m3/airwallex/*.json`: what the spec observed.
- `fixtures/replay/m3/`: `manifest.json`, `webhooks.jsonl`, `model-outputs.jsonl`, `plans.json`, `attempts.json`, `rfis.json`, `airwallex/`, `run.json`.
- Env keys this ticket introduces (names only): `E2E_MODE`, `E2E_BASE_URL`, `E2E_OWNER_EMAIL`, `E2E_OWNER_PASSWORD`, `E2E_EVIDENCE_DIR`.
