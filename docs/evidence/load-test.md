# Load test: scaling numbers measured (M4-06, 15 Nov 2026)

This file measures the numbers in `docs/architecture.md` §12 (traffic, storage) and the §9 SLO "webhook acknowledged p95 < 300 ms warm". Each number below comes from one run of `npm run load -- --profile all` (commit `21829ca` plus this branch), or from the recorded fixtures it replays. Anything not measured is labelled.

## Verdict

| Claim (architecture) | Verdict | Measured |
|---|---|---|
| §9 webhook ack p95 < 300 ms warm | **Confirmed** (local stack) | p95 45.5 ms (average), 47.0 ms (peak), 109.3 ms (burst, 3 workers), 109.6 ms (burst, 1 worker) |
| §12 about 3 webhook events per payment, 15,000 events/day | **Corrected** | 7 `payout.transfer.*` events for one payment in the recorded M2-09 run (`fixtures/airwallex/m2-run/webhooks`), plus 2 per RFI round (`rfi.action_required`, `rfi.closed`). The M1 skeleton recording also has 7. At 5,000 payments and 500 RFIs a day that is about 36,000 events/day |
| §12 0.17 requests/s average, about 2/s at a 10× peak | **Corrected** to about 0.42/s average and about 4/s peak (arithmetic from the event count above). Both are below the 20/s burst that was measured to pass |
| §12 about 5 KB of relational rows per payment | **Corrected** to **36,455 bytes per payment** (webhook path, documents excluded) |
| §12 about 25 MB/day, about 9 GB/year at 100× | **Corrected** to about 182 MB/day and about 67 GB/year (36,455 B × 5,000 payments/day) |
| §12 the worker can run several instances (`SKIP LOCKED`) | **Confirmed**: with 3 workers, no job ran twice (claim logs and DB `attempts = 1`) and all three workers took jobs |

`docs/architecture.md` §§2, 3 and 12 now carry the corrected figures and link here.

## Environment

- Machine: laptop, Intel Core i5-7300U @ 2.60 GHz (2 cores, 4 threads), 15 GiB RAM, Linux x64. The load generator, web server, workers and Postgres all ran on this one machine.
- Load average 0.86 at the start and 9.96 at the end. Other sessions were sharing the machine, so these are conservative numbers for an idle box.
- Node v24.22.1, PostgreSQL 17.11 (`postgres:17-alpine`, its own compose project), Next.js 16.4.3 production build (`next build`, then `next start`).
- Run started 2026-11-15T07:10:03Z.

## Tool choice

A Node script (`scripts/load/`, run with `tsx`, which is already a root dev dependency). Nothing new was installed, so the lockfile is unchanged. k6 was not installed. A Node script also has three things k6 lacks here:
- it signs bodies with the product's own `computeWebhookSignature`;
- it creates synthetic payments through the `@carnet/db` repos;
- it runs workers that use the real `startWorker` loop with the integration tests' recorded-response adapter (`FetchStub` plus `createAirwallexClient`).

Arrivals are open-loop: each delivery fires at its scheduled wall-clock time and never waits for an earlier response.

## Method

- **Stack.** Postgres runs in Docker. The web tier is the built app (`next start`) as a host process. The worker is 1 or 3 host processes (`scripts/load/worker.ts`, the real loop and handlers). Web and workers run on the host, not in the compose images, because the harness has to:
  - generate the webhook secret per run and hand it to the server;
  - inject the recorded-response adapter into the worker.

  Each run recreates a scratch database `carnet_load` and migrates it.
- **No external calls.** Importing the fixture loader replaces `globalThis.fetch` in each worker with a guard that throws. The Airwallex client's fetch is a local stub that answers `GET /transfers/{id}` and `GET /rfis/{id}` from recorded bodies (`m2-run` webhooks, `rfi-check1-fetch`), at the state the payment has reached so far in the plan. `noUnstubbedCalls` passed in every profile. Downstream jobs that would call the model or read balances (`rfi.draft`, `plan.rerun`) were completed by a counting no-op. They are counted below but not measured.
- **Workload.** Each synthetic payment replays the 9 recorded M2-09 events: 7 transfer events, then `rfi.action_required` and `rfi.closed`. Each payment gets its own transfer, request, RFI and event ids, and each body is re-signed with a per-run secret.
  - About 10% of deliveries are repeated later with the same event id.
  - About a third of payments have two adjacent events swapped (out-of-order delivery).
  - Gaps between arrivals are exponential (seeded), scaled to fill the profile's duration.
  - Before the measured profiles, a 6 s warm-up at 5/s was sent and is reported separately.
- **Profiles.** Average 0.17/s for 180 s, peak 2/s for 60 s, burst 20/s for 20 s with 3 workers, then the same burst with 1 worker. Each profile sends from its own TEST-NET source address, so the profiles do not share one per-IP rate-limit window. Within a profile, the default limit of 600 per minute applied.
- **Measurements.**
  - **Ack latency:** client round trip per 200 response.
  - **Server ack:** `acked_at - received_at`.
  - **Job latency:** `webhook_events.received_at` to the event job's `outbox_jobs.finished_at`.
  - **Queue depth:** PENDING, RETRY and RUNNING jobs, sampled every 0.5 s.
  - **Drain:** time from the last send until depth reaches 0.
  - **Worker CPU and RSS:** summed over the worker processes from `/proc`. The ticket suggested `docker stats`, but the workers are host processes here. The web process was not sampled.
- **Storage.** A separate open-loop run of 300 payments (2,969 deliveries, 2,700 unique events) at 50/s, with one source address per payment. It used the same route and worker. Bytes per payment = the change in `pg_total_relation_size` per table ÷ 300. `documents` is excluded and measured separately. `rate_limits` is excluded because it is pruned and holds no per-payment data.

## Results

| Run | Workers | Rate/s achieved (target) | Sent | Duplicates | Errors | Ack p50 / p95 / p99 ms | Server ack p50 / p95 / p99 ms | Job p50 / p95 / p99 ms | Max queue depth | Drain after last send |
|---|---|---|---|---|---|---|---|---|---|---|
| warm-up | 3 | 5.31 (5) | 31 | 4 | 0 | 25.1 / 56.0 / 61.2 | n/a | 635 / 1041 / 1103 | 8 | 617 ms |
| average | 3 | 0.20 (0.17) | 30 | 3 | 0 | 29.5 / 45.5 / 55.2 | 15 / 26 / 27 | 443 / 970 / 1022 | 2 | 15 ms |
| peak | 3 | 1.94 (2) | 114 | 6 | 0 | 24.3 / 47.0 / 56.8 | 13 / 25 / 38 | 340 / 895 / 983 | 3 | 741 ms |
| burst | 3 | 20.36 (20) | 406 | 46 | 0 | 26.5 / 109.3 / 164.4 | 11 / 60 / 96 | 477 / 1006 / 1046 | 27 | 1,026 ms |
| burst | 1 | 20.11 (20) | 401 | 41 | 0 | 36.0 / 109.6 / 124.9 | 16 / 64 / 86 | 689 / 1098 / 1164 | 40 | 542 ms |

Sample sizes are small for the average profile (30 deliveries) and for peak (114). Their p99 is close to the maximum.

**Worker resources.**
- CPU, summed over the workers as a share of one core: 1.0% (average), 3.6% (peak), 26.5% (burst with 3 workers), 25.1% (burst with 1 worker).
- Peak RSS: 804 MiB for 3 workers and 296 MiB for 1 worker. This includes `tsx` transpiling in-process; the bundled production worker was not measured.

**Jobs per worker (burst, 3 workers):** 187 / 203 / 233. Downstream no-op jobs in the burst: 225 `plan.rerun`, 38 `rfi.draft`.

**Duplicates and `SKIP LOCKED`.** Every profile passed these checks:
- every delivery got a 200;
- each event id was stored once and answered as new exactly once;
- one job per stored event;
- every job DONE on its first claim;
- no job id appears in more than one worker's claim log;
- every payment ended `PAID`;
- the queue drained.

`npm run load -- --check-duplicates` over the whole scratch database afterwards found:
- 3,582 events, with 3,582 distinct provider ids;
- 0 events without exactly one job;
- 0 jobs not DONE;
- 0 jobs claimed more than once;
- 0 payments not `PAID` (out of 398);
- 398 RFIs for 398 payments;
- 0 RFIs with more than one draft job.

**Reading the numbers.**
- Job latency p95 is about 1 s at every rate. The worker's idle poll (`WORKER_POLL_MS`, default 1,000 ms) dominates it, not the load.
- Both 1 and 3 workers drained a 20/s burst within about 1 s of the last send. At these rates, extra workers add safety (no job ran twice), not throughput.
- The architecture's "RFI event to draft ready p95 < 60 s" is not measured here, because drafting was replaced by a no-op.

## Storage

| Table | Bytes per payment |
|---|---|
| `webhook_events` | 25,013 |
| `outbox_jobs` | 6,663 |
| `audit_log` | 1,720 |
| `rfi_questions` | 1,475 |
| `rfis` | 983 |
| `payments` | 492 |
| `audit_chain_head` | 109 |
| **Relational total (bytes per payment)** | **36,455** |
| `rate_limits` (excluded, pruned) | 628 |

- **Extrapolation at 100× (5,000 payments/day):** 36,455 B × 5,000 ≈ 182 MB/day, about 67 GB/year.
- **Biggest table.** `webhook_events` is about 69% of the total: 9 raw bodies of about 1.7 KB each, plus indexes and page overhead. A retention rule for raw bodies (for example, drop `raw_body` after the transfer is final and reconciled) is the obvious lever. It is not built.
- **Lower bound.** The figure leaves out rows a payment creates before any webhook (approval, execution attempt, evidence, beneficiary, plans), so the real per-payment total is higher.
- **Documents (measured separately).** The 20 synthetic dataset files in `fixtures/dataset` average 17,078 bytes. Documents are stored outside the relational figure (ADR 0003).

## Caveats

- All on a local laptop stack shared with other work. This is not the hosted environment: hosted latency includes the platform's network and proxy, and this run did not measure it. The ticket keeps hosted and sandbox load testing out of scope (rate limits and a shared account), so there is no opt-in command for the deployed host. `scripts/load/run.ts` refuses any non-local database.
- Airwallex was replayed from fixtures, so only Carnet's side is measured. Airwallex's own delivery behaviour (redelivery timing, source addresses) is **unverified** here.
- **Inferred from configuration, not exercised in a run.** The webhook route limits each source IP to `RATE_LIMIT_WEBHOOK_PER_MIN`, default 600 per minute. If Airwallex sent a sustained 20/s from a single IP, the route would start answering 429 after 30 s, and Airwallex would redeliver. The burst was kept at 20 s to stay under that limit.
- Durations are the profile lengths only; there was no soak test.

## Reproduce

```bash
COMPOSE_PROJECT_NAME=carnet-load POSTGRES_PORT=$((5432 + ${PORT_OFFSET:-0})) docker compose up -d postgres
npm run build -w @carnet/web
npm run load -- --profile all --out "$TMPDIR/load.json"   # exits 1 if ack p95 >= 300 ms or a check fails
npm run load -- --check-duplicates
```

`DATABASE_URL` and `DATABASE_MIGRATION_URL` default to the synthetic local roles in `packages/db/sql/roles.sql` on `localhost:5432+PORT_OFFSET`. The web server listens on `3000+PORT_OFFSET` (`LOAD_PORT` overrides it). Raw per-run output, including queue-depth series and worker logs, goes to `$TMPDIR`.
