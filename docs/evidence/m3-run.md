# M3-07 run record: the full demo, live

One real run of storyboard steps 1-9 against the deployed Carnet (`carnet-web`, `carnet-worker`), the real Airwallex sandbox and the real model. Synthetic data; the sandbox and the model API are real. Started with `apps/web/e2e/demo-live.spec.ts` (`E2E_MODE=live`); **9 of 9 tests passed** on 2026-11-15. Every value below comes from `docs/evidence/m3/run.json` (what the spec observed), `docs/evidence/m3/airwallex/*.json`, or `fixtures/replay/m3/` (the database export of the run, scrubbed). Anything not extracted is marked **not extracted**; anything not proven is marked **UNVERIFIED** or **not shown**.

## Run facts

| Field | Value |
|---|---|
| Run prefix | `M3RUN-2611151316` |
| Start / end (UTC) | 2026-11-15 13:16:45 / 13:18:38 (9 tests, 1.9 min) |
| Deployed commit (`/healthz` version) | `846eff0beaee` (spec at `50ddd15` plus the step-8 changes in the same commit as this note) |
| Base URL | `https://carnet-web.onrender.com` |
| RFI creation path | Sandbox simulator, `POST /api/v1/simulation/rfis/create` (ADR 0018); not injected |
| History | Demo history is add-only: 30 obligations (7 in SGD) from earlier runs were still owed and in this run's plan |

## How it got here (attempts on 2026-11-15)

Earlier attempts the same day failed, and each failure was fixed in code before the run above:

1. Step 4: the spec looked for the payout card on the payment page and matched any payout card (#130, spec plus a `data-action-id` attribute on the plan action card).
2. Step 4: **product bug.** The payout executor refused every approved alternate payout with `ALREADY_SENT` and put the action back to PROPOSED, because a held payment always has its transfer. Fixed in #131 (ADR 0021 amendment 2). The first deploy of #131 ran a stale worker bundle; a `--clear-cache` redeploy shipped it.
3. Step 7: the spec could not serialize a bigint while keeping the Airwallex evidence (#132).
4. Step 8: the spec sent a body to the reuse endpoint, and assumed the model would draft the reopened question (spec change committed with this note, see Follow-up round).

Each attempt created its own payments, transfers and RFI; nothing was retried inside the recorded run.

## Steps 1-9

| # | Step | Time (UTC) | Result and ids |
|---|---|---|---|
| 1 | Goal (SGD payroll and two USD suppliers by Friday), criticality confirmed by the owner, plan (policy v1) | 13:17:22 | obligations payroll `6eec0a3b…`, Harbor `df875190…`, Lakeside `22736cfb…`; plan revision 53, `inputs_hash` `949a0840…` |
| 2 | Evidence flags, one not strong | 13:17:24 | Harbor **strong**, Lakeside **weak** (its amount USD 1,250.00 differs from the invoice, USD 1,320.50) |
| 3 | Both payments sent as real sandbox transfers | 13:17:35 | strong `a534759f-1b03-4404-ab7e-8bb34b71559c`, weak `73d6ace4-b760-46df-961f-2a557ddb6632`; sending the weak one without the owner's acknowledgement was refused (412) |
| 4 | Hold: Transaction RFI on the sent transfer, webhook verified, payment held, re-plan | 13:17:54 | Airwallex RFI `2c574dda-8eb3-4548-9418-9b49ef30d89b`, Carnet `11b3d4bc…`; visible in Carnet 5.4 s after creation; transfer PROCESSING while held; revision 55, trigger `held` (Harbor Print Co.), alternate payout `179b6e6e…` approved by the owner on the plan screen at 13:17:59 |
| 5 | Cited drafts, one bound approval, submit | 13:18:04 | round 1 drafted by the model for every question (no owner text needed); approval `de32b347…` CONSUMED; respond attempt CONFIRMED, `request_id` `98b32774-648e-46d1-85b9-64cb3c0c8549`; approval to ANSWERED 3.7 s |
| 6 | USD to SGD conversion auto-executed under policy; the approved payout executed | 13:18:09 | conversion action `f3712fe2…` (revision 52) DONE: sold USD 1,180.81, bought SGD 1,493.65, AutoApproval policy v1 hash `8095e378…`, daily cap USD 10,000.00 with USD 548.52 left; payout action `179b6e6e…` DONE; nothing deferred |
| 7 | Held transfer reaches SENT then PAID on its own status | 13:18:19 | transfer `a534759f…`: PROCESSING while the RFI was answered, then PAID after the simulated SENT and PAID transitions |
| 8 | Follow-up round (see below) | 13:18:33 | reopened "Purpose of payment", appended "Invoice number for this payment"; round 2 approval `6510ce4a…` (differs from round 1); respond attempt CONFIRMED, `request_id` `e179facf-1ca8-4554-8c1e-8f2ac0f76c96` |
| 9 | Payee page: GENERIC, opt-in while held, neither once paid | 13:18:37 | while held: GENERIC "Processing", opt-in "Delayed for verification"; after PAID: both "Paid"; required headers asserted by the spec (`expectPayeeHeaders`) |

## Money path (attempts in `fixtures/replay/m3/attempts.json`)

| Attempt | Kind | `request_id` | Status |
|---|---|---|---|
| `e52a3891…` | conversion (action `f3712fe2…`, quote `b7b4728d…`, one `fx_quote_uses` row) | `57c7b871-7ed0-41a9-afa4-4ed34e06d8f8` | CONFIRMED |
| `229c972b…` | transfer, strong payment (the original send) | `4749b301-984f-42c3-a880-8ac0cf2339ee` | CONFIRMED |
| `4e0ffe58…` | transfer, weak payment | `0fcc0ebe-cdf7-445e-afaf-824454d4b13a` | CONFIRMED |
| `bf061ec4…` | transfer, **alternate payout** for the held strong payment (approval `a3629e8b…` CONSUMED) | `76c3609f-ec17-4532-80ea-fc6fb6d3ee8a` | CONFIRMED |
| `5b76e9a7…`, `bfaa3b14…` | respond, rounds 1 and 2 | as in steps 5 and 8 | CONFIRMED |

The Airwallex ids of the conversion and of the alternate-payout transfer are **not extracted** (the export does not carry them in the attempt rows). The held payment kept its original transfer (step 7 read its status on `a534759f…`), as ADR 0021 amendment 2 requires. **Both transfers for the Harbor obligation completed in the sandbox**: that is the stated risk of an alternate payout (the payee may be paid twice).

**Money status and RFI events (AC 3): not extracted as a query.** What the run shows: the transfer was PROCESSING while the RFI was answered (step 7) and became PAID only after the transfer transitions; the 24 webhooks in `fixtures/replay/m3/webhooks.jsonl` include `payout.transfer.sent` and `payout.transfer.paid`.

## Follow-up round (AC 5): reuse not shown live

- Airwallex follow-up (simulator) reopened "Purpose of payment" and appended "Invoice number for this payment".
- `POST /api/v1/rfis/{id}/reuse` answered 201 `reused: true`.
- **The model's round-2 answer to the reopened question was off-topic**: "Invoice number INV-HP-2026-0141 from Harbor Print Co. is for USD 4,800.00 under Purchase order PO-NW-2026-031." Its quotes are real, so the verifier accepted it; the verifier checks quotes, not whether the answer addresses the question (logged to BL-01).
- The owner wrote both round-2 answers (`owner_authored_round_2`: both questions), and approved the round in the dialog (`applied_with_one_click: false`). **0 answers were still "Same as approved"** when the round was approved.
- So this run does **not** show one-click reuse of an approved answer. The README and video must not claim live reuse; reuse is covered by `apps/web/e2e/follow-up.spec.ts` (replay) and the M2-06 tests only.

## Plan revisions

| Revision | `inputs_hash` | Trigger |
|---|---|---|
| 52 (conversion executed here) | `a8e2a773…` | obligations created (step 1) |
| 53 (after criticality, step 1) | `949a0840…` | inputs changed |
| 54 (after the sends, step 3) | `d1a32313…` | inputs changed |
| 55 (after the hold, step 4) | `68b0d578…` | held (alternate payout) |

## Latency (AC 7)

- RFI creation to visible in Carnet: 5.4 s.
- Approval to ANSWERED: 3.7 s (round 1).
- Event-to-draft: the spec's `ms_event_to_draft` (367 ms) starts after step 4 ended, by which time the draft was already finished, so it is **not** an event-to-draft latency; not measured in this run.
- Webhook acknowledgement, 24 webhooks: median 9.5 ms, max 298 ms (`acked_at - received_at`).

## Model cost (AC 9)

From `fixtures/replay/m3/model-outputs.jsonl` (rows since the run start): agent runs total USD 0.99, agent steps USD 0.12. Whether step costs are already included in run costs is **not verified**, so the run cost is between USD 0.99 and USD 1.11. Models: `claude-haiku-5-5`, `claude-sonnet-5-5`. The rows include document extraction of the run's uploads.

## Demo settings (owner decisions on issue #40, not observations)

- Auto-FX policy version 1: per-action conversion limit USD 5,000.00, daily cap USD 10,000.00, USD reserve floor USD 100.00, slippage 100 bps, quote freshness 300 s; hash `8095e378d9a8a3ec072ad70735123f3fa473342c563c837b4c477bcdd9bb2551`.
- Payroll in SGD to "Lion City Payroll Pte. Ltd." (synthetic), SGD 1,500.00, criticality 1; the demo funds payroll and never pays the payee.
- The alternate payout is approved in step 4, while the payment is held.
- **Deferral is not shown live** (the sandbox holds about 10 million in several currencies, so nothing was short); it is proven by the planner tests and the plan-screen replay spec only.

## UNVERIFIED and known gaps

- Sandbox quotes return `usage: MULTI_USE` (M0-03); production behaviour unverified.
- The plan of the demo business still shows unapproved alternate payouts from the failed attempts, until their RFIs close (BL-01).
- Judge replay shows this run as a timeline only; the judge's screens come from the materialized M2 recording (no M3 materializer).

## Files

- Screenshots: `docs/evidence/m3/01-goal-and-plan.png` … `09c-*.png`.
- `docs/evidence/m3/run.json`, `docs/evidence/m3/airwallex/*.json`: what the spec observed.
- `fixtures/replay/m3/`: `manifest.json`, `webhooks.jsonl`, `model-outputs.jsonl`, `plans.json`, `attempts.json`, `rfis.json`, `airwallex/`, `run.json` (scrubbed; `./scripts/check-no-secrets.sh` ok).
