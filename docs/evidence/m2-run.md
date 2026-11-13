# M2-09 run record: the core demo, live

**What this is.** One real run of storyboard steps 1-8 against the **deployed** Carnet (`carnet-web` on Render, commit `2331449`), the **real Airwallex sandbox** and the **real model** (Claude Haiku 5.5 for extraction, Sonnet 5.5 for drafting). Nothing in the product path was stubbed. The data is synthetic (`fixtures/dataset/`); the sandbox and the model API are real.

**How it was run.** `apps/web/e2e/core-demo.live.spec.ts` (Playwright, `E2E_BASE_URL=https://carnet-web.onrender.com`), started by the owner. Steps 1-5 ran on 2026-11-12 (07:48Z); steps 6-8 ran on 2026-11-13 (09:20-09:23Z) after the fixes listed under "What went wrong first". The database side of this record (model steps, costs, audit entries, webhooks) comes from `scripts/demo-export.sh`, a read-only export job that ran on the deployed image on 2026-11-13. All times are UTC.

**What it shows, and what it does not.** It shows the core loop working end to end once, with the owner completing one answer the verifier rejected. It does **not** show a fully automatic answer: on every attempt the real model failed or was rejected on one of four questions (see "Model behaviour"). It was one run on a sandbox account; the sandbox's behaviour (for example, it does not enforce the documented file-size limit, M0-04) is not Airwallex's production behaviour.

## Steps 1-8

| # | Step | Time (UTC) | Result |
|---|---|---|---|
| 1 | Owner signs in on the deployed app | 07:48:27 | 200; deployed version `2331449c82f9` |
| 2 | Upload dataset documents; extraction runs | 07:48:27-07:48:51 | 6 documents. Five text-layer documents: every fact quote verified (6, 9, 9, 9 and 10 facts). `inv-lakeside-002` (the injection document) is flagged `instruction_phrase` (`ignore-previous`, and others) in its stored facts. `inv-nordlicht-scan-001` (image-only): 7 facts, all `no_text_layer`, none usable |
| 3 | Owner confirms the scan's facts | 07:48:51 | Facts version 2, source `owner`; the model's version 1 stays unverified |
| 4 | Two payments saved, evidence attached, flags computed | 07:48:53 | Harbor Print Co. USD 4,800.00 (invoice, PO, contract): **strong**. Lakeside Freight LLC USD 1,320.50 (invoice only): **missing** (no contract on file) |
| 5 | Send both as real sandbox transfers | 07:48:55-07:48:59 | The Missing payment without acknowledgement: **412**, nothing sent. With acknowledgement: sent, audit entry `evidence_override` (07:48:55.841). Strong payment sent directly. Transfers `2662e6a4-e664-4d74-be1f-9889655df125` (Harbor) and `4b9e8961-7124-4451-b294-1602a4c6c516` (Lakeside) |
| 6 | Simulated TRANSACTION RFI on the Harbor transfer | 09:20:15 | Created with `POST /api/v1/simulation/rfis/create` through the `SandboxSimulator` port on a plain account, **no injection fallback needed** (ADR 0018, M0-04). RFI `1e753bea-ff0c-4b2a-868c-9c266a36f765` (Carnet id `0c96b34b-8476-42de-8f87-4a39e983fa12`), 4 questions (2 TEXT, 2 ATTACHMENT), all with the transfer as source. Webhook `rfi.action_required` received 09:20:15.154, acknowledged in 7 ms, linked to the payment by match |
| 7 | Draft, approve, respond | 09:20:29-09:22:10 | Model draft stored 09:20:29.749. Owner completed one answer 09:22:06.560. Approval granted 09:22:08.771 and consumed 09:22:09.328. Two attachments uploaded to the Airwallex files host (09:22:09.838, 09:22:10.137). Respond sent 09:22:10.143, **confirmed 09:22:10.334**: execution attempt `82d87956-5f40-4eb7-b03a-e9b95ba384f4` (kind `respond`, request id `60e289e4-bea3-4705-96d2-f64d621653a8`) status **`CONFIRMED`**, approval status **`CONSUMED`**. Webhook `rfi.answered` received 09:22:10.523. RFI state **`ANSWERED`** |
| 8 | Simulator closes the RFI; the transfer reaches SENT and PAID | 09:22:12-09:23:20 | RFI closed (webhook `rfi.closed` 09:22:12.972); Carnet shows it `CLOSED`. Transfer stayed **`PROCESSING`** while the RFI was answered and closed. Then `SENT` (webhook 09:22:17.138) and `PAID` (webhook 09:23:20.613), both asked for through `POST /api/v1/payments/{id}/simulate`. Final status of transfer `2662e6a4-...`: **`PAID`** |

The respond body contained **every question**: the owner draft that was approved has 4 answers (3 VERIFIED, 1 OWNER_AUTHORED), `hold-view-final.json`. Two of them are attachment answers, the files are in the attempt (`fixtures/airwallex/m2-run/respond-attempt.json`: `remit-brightline-001.pdf` and `dn-harbor-001.pdf`, each with its sha256 and Airwallex file id).

## Money status was never set by an RFI event

- The audit log of the run holds only `rfi.*`, `draft.*`, `approval.*`, `attempt.*`, `respond.*`, `answer.*` and `document.*` entries for the RFI; no entry changes a payment's status.
- The Harbor payment's `transfer_status` and `transfer_updated_at` (`PAID`, 09:23:20) match the `payout.transfer.paid` webhook, not an RFI webhook.
- After the RFI was closed (09:22:12) the transfer was still `PROCESSING` (observed by the spec through `GET /api/v1/payments/{id}`, recorded in `run.json`); it moved only when we asked the simulator for `SENT` and `PAID`.
- The webhook stream is in `fixtures/airwallex/m2-run/webhooks/`, in order.

## Measured against the SLOs (architecture §9)

| SLO | Target | Measured | Verdict |
|---|---|---|---|
| Webhook acknowledged | p95 < 300 ms warm | 19 webhooks: min 6 ms, median 8 ms, **p95 21 ms**, max 24 ms (`acked_at - received_at`) | Met |
| `rfi.action_required` to draft ready | p95 < 60 s | Event received 09:20:15.154, **model draft stored 09:20:29.749 = 14.6 s** (one question NEEDS_OWNER, so that draft was not "ready" for approval). The first approvable draft is the owner's, at 09:22:06.560, because the owner took the time to write the answer | The model part met the target. **Not measurable as stated**: no draft was DRAFT_READY on model output alone in this run |
| Approval to RFI answered | p95 < 30 s | Approval granted 09:22:08.771, respond confirmed 09:22:10.334: **1.56 s** (browser-side 3.4 s, including the poll interval) | Met |
| Payments marked SENT/PAID from an RFI event alone | zero | Zero (see above) | Met |

One run is not a p95. These are single observations (or, for the webhook acknowledgement, 19 of them from one session) and the claim in any README must say so.

## Model behaviour and cost

Three real-model drafts were made across three RFIs (the first two RFIs are explained below), each on the four Harbor questions, plus six extractions:

| Run | Time | Model | Latency | Cost (USD) |
|---|---|---|---|---|
| extraction x 6 | 07:48:28-07:48:46 | Haiku 5.5 | 2.1-6.2 s each | 0.00055, 0.00045, 0.00132, 0.00055, 0.00055, 0.00070 (total 0.0041) |
| draft, RFI 1 (`18e60744`) | 07:57:03 | Sonnet 5.5 | 7.4 s | 0.0216 |
| draft, RFI 2 (`8fee9796`) | 09:14:15 | Sonnet 5.5 | 14.8 s | 0.0322 |
| draft, RFI 3 (`1e753bea`, the answered one) | 09:20:15 | Sonnet 5.5 | 14.0 s | 0.0347 |

- **Total model spend of everything recorded here: USD 0.0926.** The run that was answered (extraction + its draft) cost **USD 0.0388**, below `MODEL_PER_RUN_CAP_USD` (0.50). The daily cap (10.00) was not approached.
- **The live model did not draft all four questions on any attempt.** RFI 1 ended NEEDS_OWNER; the delivery note and the remittance advice that its two attachment questions need were not on file yet (I did not save which question(s) it declined). RFI 2: "Purpose of payment" came back `NEEDS_OWNER / CANNOT_ANSWER` ("Your documents do not contain what this question asks for"). RFI 3: "Relationship with the counterparty" came back `NEEDS_OWNER / UNSUPPORTED_TOKEN` (the verifier rejected an answer saying something the cited documents do not say). The recorded M2-05 drafts had answered all four questions; the live model did not, and not the same one each time.
- The verifier worked as designed: nothing was sent that was neither verified nor the owner's own words. For RFI 3 the owner's statement ("Harbor Print Co. is our regular printing supplier ...") is stored as `OWNER_AUTHORED`.

## What went wrong first (nothing hidden)

1. **Documents were uploaded without a `kind`** (my spec's first version), so they were stored as `other` and extraction was never queued. A re-upload of identical bytes is deduplicated and queues nothing, and no API changes a stored kind. **Workaround:** each run inserts one PDF comment line just before `startxref` (hash changes, xref offsets and the text layer do not; checked with `unpdf`). The documents in this run therefore differ from `fixtures/dataset/` by that one line. Logged to BL-01.
2. **Airwallex login from the test machine returned 403** until the owner added the machine's IP to the sandbox key's allowlist (`docs/deployment.md` describes this).
3. **RFI 1** was created before the delivery note and remittance advice were uploaded; **RFI 2**'s first owner draft carried only one of four answers (my spec bug, the other three showed `ANSWER_MISSING`). Both were closed by the simulator and replaced. They are part of the run, not edited out.
4. **The first demo-seed job on Render failed once** with a database error whose cause I did not capture; the next run, after the seed script gained error reporting, succeeded (6 payees inserted). The first failure is unexplained.
5. **GitHub CI flaked repeatedly** during this work (a package-mirror outage, and one intermittent test, `csp.spec.ts`); logged to BL-01. It delayed the deploy of the export job and does not affect the product.

## What was not exercised live

- EUR payees and the SWIFT rail (the demo beneficiary the worker creates is USD; `docs/evidence/dataset.md`).
- The image-only scan's own payment (EUR): its facts were confirmed, no transfer was made for it.
- The Lakeside payment's RFI, the follow-up round (M3-05), conversions and payouts under a plan (M3).
- Production Airwallex behaviour; limits the sandbox does not enforce.

## Files

- Screenshots (`docs/evidence/m2-run/`): `01-queue-with-flags.png`, `02-evidence-view-weak.png`, `03-hold-screen-with-snippets.png`, `04-approval-dialog.png`, `05-answered-state.png`, `06-queue-after-run.png`. Synthetic data only.
- `docs/evidence/m2-run/run.json`: what the spec observed from the client, with timestamps (it also holds the earlier attempts).
- `docs/evidence/m2-run/hold-view-final.json`: the hold screen's read model for the answered RFI, taken when the owner's draft became `DRAFT_READY` (shows the 3 VERIFIED answers with citations and the 1 OWNER_AUTHORED one).
- `fixtures/airwallex/m2-run/`: the 19 webhooks as Carnet stored them (account id scrubbed; re-sign before replay) and the respond attempt. `fixtures/anthropic/m2-run/` (model responses, reconstructed from the stored step output) and the CI replay spec are in the replay PR.
- Reset: `scripts/demo-reset.sh` (idempotent; adds the six dataset payees, never deletes; owner decision 2026-11-11). Export: `scripts/demo-export.sh <since-iso> <out.jsonl>`.
