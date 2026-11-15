# Carnet

> A payment that carries its paperwork. Carnet makes a cross-border payment survive Airwallex's risk review, and keeps payroll on time while it does.

Built for the Airwallex Agentic Banking Hackathon (Oct–Nov 2026). Sandbox only; every document and counterparty is synthetic.

How to read this README: every number links to the evidence file it comes from in [`docs/evidence/`](docs/evidence/). Where we infer something, we say so. Where Airwallex behaviour was not verified, we mark it **unverified**. Sections marked **TODO after the M3 live run** are waiting for the full live run recording ([`docs/evidence/m3-run.md`](docs/evidence/m3-run.md)). Until then they make no claim.

## Problem

A business sends a supplier payment or receives a client payment, and the provider's risk team holds it and asks for paperwork. Airwallex's own documentation says what such a request usually asks for:

> "This is commonly a request for supporting documents relating to the transaction itself such as invoices or contracts"
>
> — Airwallex Docs, [Handle Transaction RFI](https://www.airwallex.com/docs/banking-as-a-service/risk/rfi-(request-for-information)/handle-transaction-rfi), opened 2026-11-15

**Who suffers.** We expect the people hit hardest to be founder-operators of small cross-border agencies, part-time finance leads at importers and solo exporters, where the person who makes the payment also has to answer for it. While a payment is held they have three jobs at once:
- find and send the right documents, often more than once;
- keep payroll and other suppliers paid from what is left;
- tell a supplier where a payment is that nobody can see.

**Why it is unsolved.** Airwallex offers ways to *answer* a Transaction RFI (an embedded component, a hosted flow and the Connected Account Console, listed on the page above), but none of them prepares the answer from the business's own documents or re-plans other payments during the hold. *Inference:* the pain is the same at every payment provider, but Airwallex's RFI API is the only one we could demonstrate in a sandbox.

*Quote note:* our research also gathered first-person forum posts about held payments, payroll due during a hold, and repeated document requests. Reddit refused automated fetches when we tried to re-open them on 2026-11-15. We could not confirm them verbatim that day, so they are left out.

## Solution

Carnet runs the whole review loop for one business, in plain steps:

1. **State the goal.** For example, "payroll and two suppliers by Friday". Carnet turns it into obligations and a plan. Shown live in the M3 run: payroll in SGD and two USD suppliers, criticality confirmed by the owner, a plan under policy v1 ([`m3-run.md`](docs/evidence/m3-run.md) step 1).
2. **Check the evidence before money moves.** Each payment gets an evidence flag computed from the owner's documents (invoice, purchase order, contract). If a payment's flag is "missing", it can only be sent after an explicit acknowledgement, which is written to the audit log. Shown live in the M2 run: a "missing" payment without acknowledgement got **412**, and nothing was sent ([`m2-run.md`](docs/evidence/m2-run.md) step 5).
3. **Approve and send.** The payment goes out as a real Airwallex sandbox transfer.
4. **A payment is held.** Airwallex raises a Transaction RFI. Carnet receives the webhook, checks the signature, fetches the RFI and links it to the payment. The RFI never changes the payment's money status. That status always comes from the transfer itself.
5. **Cited drafts.** The model drafts an answer to every question, using only facts extracted from the owner's documents. Code checks each claim against the cited quote (the verifier). A question that cannot be grounded goes back to the owner as `NEEDS_OWNER`, never as a guess.
6. **One bound approval.** The owner approves the exact answer set. The approval is tied to a hash of that content. Carnet sends the answers only if the content still matches, and an approval can be used only once.
7. **Plan revised.** While the payment is held, the plan re-runs. It can make a conversion that falls within a policy limit, propose an alternate payout that needs approval, or defer a payment. Shown live in the M3 run: a USD to SGD conversion auto-executed under the policy, and the alternate payout for the held payment approved by the owner and executed as a new sandbox transfer, while the held transfer kept its own status ([`m3-run.md`](docs/evidence/m3-run.md) steps 4 and 6). **Not shown live:** deferral (the sandbox balances had no shortfall); it is covered by the planner tests and the plan-screen replay spec.
8. **Outcome tracked.** Carnet follows the transfer's own status to `SENT` and `PAID`, and treats neither as final.
9. **Follow-up reuse.** If Airwallex reopens a question, an answer the owner already approved can be reused in one click. **Not shown live:** in the M3 run the reviewer reopened a question, the model's new answer to it was off-topic (real quotes, wrong question), and the owner wrote both round-2 answers before approving ([`m3-run.md`](docs/evidence/m3-run.md), Follow-up round). Reuse is covered by the replay spec `apps/web/e2e/follow-up.spec.ts`.

**What is different (stated vs inferred).** Stated: Airwallex documents RFI answering *screens* (embedded component, hosted flow, console), which we read on the docs page cited above. Inferred: we found no product that drafts grounded answers from the business's documents and also re-plans the business's other payments during the hold.

## Why now

- **Airwallex exposes RFIs as an API, with simulators.** A plain sandbox account can create simulated Transaction RFIs with `POST /api/v1/simulation/rfis/create`. It can also answer them, close them, and move transfers through `SENT`, `PAID` and `FAILED` while an RFI is open ([`rfi-spike-decision.md`](docs/evidence/rfi-spike-decision.md)). That makes it possible to build and test the full review loop against the real provider.
- **Agentic banking needs governed execution.** A model can read documents and draft answers well, but nobody should hand it money. In Carnet the model holds no credentials and no money tools. Code decides, the owner approves exact content, and the executor acts only on approvals ([ADR 0009](docs/adr/0009-deterministic-workflow-no-money-tools.md)).

## Architecture

The full design is in [`docs/architecture.md`](docs/architecture.md), and the decisions are in [`docs/adr/`](docs/adr/).

```mermaid
flowchart TB
    owner(["Owner<br/>(browser)"])
    airwallex[("Airwallex<br/>sandbox")]
    anthropic[("Anthropic API")]

    subgraph carnet["Carnet"]
        web["<b>web</b> mode (Next.js)<br/>UI · /api/v1 · /api/webhooks/airwallex<br/>/status/:token · /ops · /healthz"]
        db[("<b>PostgreSQL</b><br/>documents · facts · payments · RFIs<br/>drafts · approvals · attempts · plans<br/>outbox · webhook events<br/>audit (hash chain) · agent runs")]
        worker["<b>worker</b> mode<br/>job loop (1 s) + reconcile (60 s)"]
        agent["<b>agent package</b><br/>3 typed calls + verifier<br/>no tools · no keys · no money"]
        executor["<b>executor</b><br/>acts on approvals only"]
        adapter["<b>Airwallex adapter</b><br/>timeouts · lookup before retry"]
    end

    owner -- "reviews, approves exact content" --> web
    airwallex -- "webhooks (HMAC verified)" --> web
    web -- "webhook_events → outbox_jobs" --> db
    db --> worker
    worker --> agent
    agent -- "typed calls" --> anthropic
    worker --> executor
    executor --> adapter
    adapter --> airwallex
```

Trust boundaries: the browser · Airwallex (HMAC-verified webhooks) · documents and RFI text (untrusted data, never instructions) · model to executor (the executor acts only on approvals).

The controls, in five lines:
- **Bound approvals.** An approval covers a hash of the exact content. It is consumed once and refused if the content changed ([ADR 0008](docs/adr/0008-bound-approvals.md)).
- **Execution attempts.** Every money or respond call is recorded first with one `request_id`. After a timeout, Carnet looks the object up instead of resending ([ADR 0007](docs/adr/0007-execution-attempts-and-unknown-outcomes.md)).
- **Grounded drafting and the verifier.** Every amount, date, name and reference in a draft must appear in a cited, quote-verified fact. Anything else fails closed to `NEEDS_OWNER` ([ADR 0010](docs/adr/0010-grounded-drafting-and-quote-verification.md)).
- **Code decides, the model judges.** The workflow is deterministic. The model gets typed calls with no tools, and document text is treated as data, never as instructions ([ADR 0009](docs/adr/0009-deterministic-workflow-no-money-tools.md)).
- **Audit chain.** Audit rows are hash-chained, and the chain is checked on `/ops` ([ADR 0013](docs/adr/0013-audit-log-hash-chain.md)). This limit applies: see [Limits](#limits).

## Demo

- **Video:** [Carnet demo (3:29, YouTube, unlisted)](https://youtu.be/MgKlYqolyVM). Recorded on the Airwallex sandbox with synthetic documents; segments labelled TEST DATA use seeded data on a local copy; AI narration; nothing sped up.
- **Deployed app:** https://carnet-web.onrender.com (Airwallex sandbox only). **Judge login:** `judge@carnet.example`. The password is in the submission form. It opens a read-only, labelled playback of real recorded runs: the M2 core demo (12 Nov 2026), with its screens, and the M3 full demo (15 Nov 2026) as a timeline. Every screen shows "Recording of a real sandbox run … Nothing here is live", and every write is refused (403).
- **Hold screen** (from the M2 live run: drafted answers with the cited document snippets):

  ![Hold screen with cited snippets](docs/evidence/m2-run/03-hold-screen-with-snippets.png)

- **Bound approval dialog** (M2 live run):

  ![Approval dialog](docs/evidence/m2-run/04-approval-dialog.png)

- **Plan screen**, live M3 run: the alternate payout executed while the payment was held ([`m3-run.md`](docs/evidence/m3-run.md) step 6).

  ![Plan screen](docs/evidence/m3/06b-plan-payout-executed.png)

## Evals and measured claims

Everything below comes from one recorded run or from a replayable eval. One run is not a p95; single observations are labelled as such.

**Extraction** ([`extraction-eval.md`](docs/evidence/extraction-eval.md); synthetic dataset, recorded live 2026-11-06, replayed deterministically since):
- 106 of 106 ground-truth fields correct; 134 of 134 extracted facts quote-verified against the PDF text layer; wrong-but-verified: 0.
- Quote-mutation detection: 402 of 402.
- The prompt-injection document was flagged, and its facts still matched the ground truth. All 21 facts from image-only files were held for owner confirmation; none were auto-verified.
- What it does not show: behaviour on real, unseen documents. The same team wrote the dataset and the prompts.

**Draft verifier** ([`verifier-eval.md`](docs/evidence/verifier-eval.md)):
- 651 mutants of good drafts, and every one was rejected (100%). The mutants cover wrong amount, currency, date, reference or name, invented facts, foreign citations, changed quotes, URLs, instruction strings, dropped citations, attachment tricks and unsupported answer types.
- 28 of 28 good drafts were accepted.
- What it does not show: the verifier proves that a statement is *supported* by the cited facts, not that it is *true*. See [Limits](#limits).

**M2 core demo, live** ([`m2-run.md`](docs/evidence/m2-run.md); deployed app, real Airwallex sandbox, real model, 2026-11-12 and 2026-11-13):
- A simulated Transaction RFI on a real sandbox transfer was received by webhook, drafted, answered with every question after one bound approval, and confirmed. The transfer stayed `PROCESSING` while the RFI was answered and closed, and only then reached `SENT` and `PAID` on its own status.
- The webhook acknowledgement was measured over 19 webhooks in one session: median 8 ms, p95 21 ms.
- `rfi.action_required` to model draft stored: 14.6 s (one observation).
- Approval to answer confirmed: 1.56 s (one observation).
- Payments marked `SENT`/`PAID` by an RFI event: zero.
- Model spend for everything in the record: USD 0.0926.
- **What it does not show:** a fully automatic answer. On every attempt the live model either declined or was rejected by the verifier on one of the four questions. The owner wrote that answer, and it is stored as `OWNER_AUTHORED`.

**M3-03 money path, live** ([`m3-03-live.md`](docs/evidence/m3-03-live.md); 2026-11-14):
- One real sandbox conversion executed under the auto-approval policy, ending `SETTLED`.
- One real payout sent after a bound approval: attempt `CONFIRMED`, transfer created `SCHEDULED`. It was not followed to a final status.
- The slippage guard refused live attempts when the real sandbox rate had moved past the policy bound.

**M3 full demo, live** ([`m3-run.md`](docs/evidence/m3-run.md)): all 9 storyboard steps passed against the deployed app, the real sandbox and the real model on 2026-11-15 (run `M3RUN-2611151316`). Measured in that run: the RFI was visible in Carnet 5.4 s after creation; approval to answered took 3.7 s; 24 webhooks were acknowledged with a median of 9.5 ms (max 298 ms); model cost was between USD 0.99 and USD 1.11. Earlier attempts that day found and fixed a real bug (an approved alternate payout could never execute); the run note lists them.

**Accessibility and Core Web Vitals** ([`a11y-cwv.md`](docs/evidence/a11y-cwv.md), M4-07): axe found 0 WCAG 2.2 A/AA violations in 84 of 84 checks (42 screen states, light and dark). On the hosted app, 16 of 16 route, device and cache groups met the budgets (LCP < 2.5 s, CLS < 0.1, INP < 200 ms) on the median of 5 runs. The closest is the mobile hold screen: INP median 168 ms cold and 184 ms warm, with worst runs of 224 ms and 240 ms.

**Load** ([`load-test.md`](docs/evidence/load-test.md), M4-06, local stack on one laptop): webhook acknowledgement p95 was 45.5 ms at average load and 109.3 ms in a 20/s burst, against a 300 ms target. With 3 workers no job ran twice.

**Eval suite** ([`evals.md`](docs/evidence/evals.md), M4-03):
Numbers below are copied from [`docs/evidence/evals.md`](docs/evidence/evals.md) (replay mode: the
pipeline and the code verifier over recorded real model replies, no model call); `python3 scripts/check-readme-numbers.py`
fails if they drift. Run it yourself with `npm run eval -- --mode replay`.

- cases: 76 ground-truth cases (extraction, drafting, verifier); ground-truth cases passed: 75
- mutation rejection: 100% of mutants: 721 wrong drafts (numbers, dates, names, currencies, citations) all rejected by the verifier
- grounding rate: 95% of answerable RFI questions came back with every claim matched to a cited quote
- extraction accuracy: 100% field-level on the synthetic dataset, quote verification: 100% against the PDF text layer
- adversarial cases: 26 (hidden instructions, contradicting or missing documents, image-only scans, follow-up reuse), all safe

The dataset is small and synthetic, and the prompts were tuned on it; these numbers show the controls
work, not accuracy on unseen documents.

## Future vision

None of this is built:
- information requests from other providers (for example Wise, Payoneer, Stripe), using the same evidence model;
- accountants and bookkeepers managing many small clients from one place;
- account-level and onboarding reviews, not only transaction RFIs;
- a payment-readiness score shown before a payment is sent.

## How to run

### Prerequisites
- Node 24 and npm 11 (the toolchain record used Node 24.22.1 and npm 11.19.1: [`toolchain.md`](docs/evidence/toolchain.md); `engines` in `package.json` requires `node >=24 <25`, `npm >=11`)
- Docker with Compose (Postgres 17, plus the web and worker images)
- `make`
- Python 3, only for the helper scripts that use it

### 1. Local stack (database, web, worker)

```bash
git clone <this repo> carnet && cd carnet
npm ci
cp .env.example .env                      # optional; fill it in first (step 2) for the live flow
make up                                   # builds the image; starts postgres, web (port 3000) and worker; waits for health
npm run db:migrate -w packages/db         # applies migrations as the local carnet_migrator role
```

A fresh Postgres volume creates the two local roles (`carnet_migrator` and `carnet_app`, from `packages/db/sql/roles.sql`) automatically. `make reset` drops the volume and migrates again. `make down` stops everything.

**What the containers read.** `docker-compose.yml` loads `.env` into the `web` and `worker` containers when the file exists (`env_file` with `required: false`); without it the stack still starts. Three values are fixed by compose and win over `.env`: `DATABASE_URL` (the compose Postgres as `carnet_app`), `PROCESS_MODE` (`web` or `worker`) and `NODE_ENV=production`. For a local run keep `APP_BASE_URL` and `BETTER_AUTH_URL` at `http://localhost:3000` and set `BETTER_AUTH_SECRET`. After editing `.env`, run `make up` again so the containers pick it up. Without `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY` the worker starts in degraded mode: it stays up and logs that it is not processing jobs. With them, the machine running Docker must be on the Airwallex key's IP allowlist (step 2).

Next, seed the demo business and the three demo users (owner, approver, judge). Choose your own passwords, each at least 8 characters:

```bash
DATABASE_URL=postgres://carnet_app:carnet_app@localhost:5432/carnet \
SEED_OWNER_PASSWORD=... SEED_APPROVER_PASSWORD=... SEED_JUDGE_PASSWORD=... \
npx tsx scripts/setup.ts
```

Then open http://localhost:3000 and sign in as `owner@carnet.example` with `SEED_OWNER_PASSWORD`.

### 2. Keys and environment (names only; values never go in the repo)

Copy [`.env.example`](.env.example) to `.env` and fill it in (`.env` is gitignored; the local containers load it, see step 1). The keys the core flow needs:
- **Airwallex sandbox:** `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY`, `AIRWALLEX_BASE_URL`, `AIRWALLEX_FILES_URL`, `AIRWALLEX_WEBHOOK_SECRET`. Create a sandbox account and an API key in the Airwallex web app. Use **sandbox keys only**. The key has an IP allowlist: every machine or host that logs in must be on it, or login returns an HTML 403 ([`docs/deployment.md`](docs/deployment.md)).
- **Anthropic:** `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_EXTRACT`, `ANTHROPIC_MODEL_DRAFT`. The recorded runs used Claude Haiku 5.5 for extraction and Sonnet 5.5 for drafting.
- **Database:** `DATABASE_URL` (app role), `DATABASE_MIGRATION_URL` (migration role), `TEST_DATABASE_URL`
- **App:** `APP_BASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `PROCESS_MODE` (`web` or `worker`)
- **Demo users:** `SEED_OWNER_PASSWORD`, `SEED_APPROVER_PASSWORD`, `SEED_JUDGE_PASSWORD`
- **Limits and controls** (code has defaults): `MODEL_DAILY_SPEND_CAP_USD`, `MODEL_PER_RUN_CAP_USD`, `AGENTS_ENABLED`, `EXECUTION_ENABLED`, `UPLOAD_MAX_BYTES`, and the others listed in `.env.example`

### 3. Hosted deployment and the webhook

The live runs used Render, deployed from [`render.yaml`](render.yaml) as one image in two process modes (`web` and `worker`). First-time setup (roles, migrations, seed), the environment group and rollback are covered step by step in [`docs/deployment.md`](docs/deployment.md).

- **Webhook subscription:** in the Airwallex sandbox web app, subscribe to `rfi.*` and `payout.transfer.*` events at `https://<your host>/api/webhooks/airwallex` (it must be a public HTTPS URL). Store the subscription's signing secret as `AIRWALLEX_WEBHOOK_SECRET`.
- **Without a webhook:** the worker's reconcile loop polls Airwallex every 60 s, so the flow still progresses, just more slowly.
- **Demo reset (hosted):** `./scripts/demo-reset.sh` runs an idempotent seed job on `carnet-web` that adds the six dataset payees. It never deletes anything (needs the Render CLI).
- **Judge replay login:** `npm run demo:reset -- --yes` with `DATABASE_URL` pointing at the hosted database and `SEED_JUDGE_PASSWORD` set. It creates the judge user and loads every recording under `fixtures/replay/`. It is idempotent and never deletes a live run's rows. See [Demo](#demo).

### 4. Checks

```bash
make check                                # typecheck, lint (Biome + dependency direction), tests
./scripts/landing-checks.sh               # the full chain CI runs on every PR
```

## Limits

**Scope.**
- Sandbox only: no real money and no production keys. Every document, counterparty and customer in the dataset is synthetic. The Airwallex sandbox and the model API are real.
- Airwallex Transaction RFIs only. Carnet never contacts payees or third parties. It does not unfreeze accounts or bypass any provider's review: it helps the owner answer the review.

**Simulation and replay disclosures.**
- RFIs were created with Airwallex's own simulation endpoint (`/simulation/rfis/create`) on a plain sandbox account. **The ADR 0018 local-injection fallback was not used.** It was not needed in M0-04 ([`rfi-spike-decision.md`](docs/evidence/rfi-spike-decision.md)) or in the M2 live run ([`m2-run.md`](docs/evidence/m2-run.md)). The M3 live run used the same simulation endpoint, not injection ([`m3-run.md`](docs/evidence/m3-run.md), Run facts).
- Transfer status changes (`SENT`, `PAID`) in the runs were requested through Airwallex's sandbox simulation endpoint.
- Judge login: the design ([ADR 0018](docs/adr/0018-sandbox-simulator-and-replay-mode.md)) is that the judge login plays back a recorded real run, labelled as a recording. Built (M4-05): the judge account is always in replay mode, and each recording is labelled with its capture date.
- CI replays recorded real responses. The M2 replay covers only the Carnet side; the Airwallex side is covered by the single live run.

**Airwallex behaviour that was unverified, or differed from our expectations** (sandbox observations, not production behaviour):
- The sandbox enforces neither the documented 20 MB file limit (a 22 MB file was accepted) nor any limit on TEXT answer length. Carnet enforces its own caps ([`rfi-spike-decision.md`](docs/evidence/rfi-spike-decision.md)).
- A second open RFI is rejected only for the **same type and the same source**; RFIs on other sources coexist. Carnet keeps its own per-source guard (ADR 0018 amendment).
- Held funds show only as the debit at transfer creation. `pending_amount` and `reserved_amount` stayed 0 while an RFI was open.
- FX quotes came back `usage: MULTI_USE`, and one quote was converted twice. Carnet still treats quotes as single-use. Production behaviour is **unverified** ([`airwallex-money-path.md`](docs/evidence/airwallex-money-path.md)).
- A simulated failure arrives as both `payout.transfer.failed` and `payout.transfer.cancelled`, and fetching the transfer returns `CANCELLED`. Webhooks were not delivered in order, and RFI webhooks carry no source, so Carnet fetches the object every time ([`airwallex-webhooks.md`](docs/evidence/airwallex-webhooks.md)).
- Simulation transitions sometimes returned a 500 even though the change was applied.
- The M3-03 payout was not followed past `SCHEDULED`. Quote single-use and webhook delivery for those objects were not verified there ([`m3-03-live.md`](docs/evidence/m3-03-live.md)).

**Accepted limitations (from our backlog):**
- **Support, not truth.** The verifier proves that a draft says only what the cited facts say, not that it is the right statement. Swapping two cited values (invoice date for due date, buyer for supplier) passes. The control is owner review of each claim beside its cited snippet.
- **Owner statements may be sent.** An owner-edited answer that fails the verifier can still be approved and sent, labelled "Your statement / Not found in your documents". The M2 run's owner-authored answer took this path.
- **Attachments are chosen by file name and kind only** for delivery notes and remittance advices, which have no extraction schema. The owner reviews the exact file list before approval.
- **Partial invoicing fails closed.** An invoice whose total differs from its purchase order's total is marked conflicting, and answers that cite either document become `NEEDS_OWNER` until the owner confirms the facts.
- **Stuck drafts are not re-drafted automatically.** An RFI left in drafting past the run limit gets a system `NEEDS_OWNER` draft, and the owner writes the answers.
- **Conflict flag is sticky.** If a second open RFI with the same type and source arrives (Airwallex forbids this), it is flagged as a conflict. The flag is re-checked only when that RFI changes.
- **Audit chain coverage.** Tamper evidence covers only audit rows from migration 0017 on; earlier rows predate the chain and cannot be back-filled. The app role can write the chain head, so the proven tamper cases are those at the migration-role level. There is no external anchoring.
- **IP allowlist dependency.** The Airwallex key's IP allowlist must hold the hosting provider's outbound ranges and every developer IP; otherwise login fails with a 403.
- **Kill-switch label.** An approval ended by the kill switch is `EXPIRED` with `end_reason = KILL_SWITCH`; there is no separate revoked status. The behaviour is the same.

## Licence
MIT, see [`LICENSE`](LICENSE).
