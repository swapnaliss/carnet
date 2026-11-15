# Carnet system design

Carnet makes a cross-border payment survive Airwallex's risk review. It checks the evidence for each payment before it
moves, drafts answers to Airwallex Transaction RFIs from the owner's documents, executes only what the owner has approved
(approvals are bound to the exact content), and re-plans payroll and supplier payments while a payment is held.

Decisions are recorded as ADRs in [`docs/adr/`](adr/). The Airwallex behaviour this design relies on, and what is still
unverified, is in [`docs/evidence/airwallex-rfi-contract.md`](evidence/airwallex-rfi-contract.md).

## 1. Requirements

K = known (with source), A = assumed (with how it is validated).

| Area | Requirement | K/A |
|---|---|---|
| Functional | F1 ingest documents and extract facts · F2 payment queue with evidence-strength flags · F3 create beneficiary, FX conversion and transfer under approval · F4 receive RFIs by webhook and poll · F5 draft cited answers · F6 bound approval, then respond and upload · F7 re-plan under a hold · F8 payee status page · F9 append-only audit | K: product definition |
| Load, launch | 1 business, ≤ 50 payments/day, ≤ 5 RFIs/day | A: demo scale |
| Load, 100× | 100 businesses, 5,000 payments/day, 500 RFIs/day; 7 webhook events per payment (recorded M2-09 run) plus about 2 per RFI round is about 36,000 events/day = 0.42 requests/s average, about 4/s at 10× peak | Corrected by the load test ([evidence](evidence/load-test.md)) |
| Latency | Webhook acknowledged p95 < 300 ms warm (cold start up to 2 s tolerated, duplicates are de-duplicated) · RFI event to draft ready p95 < 60 s · UI server p95 < 500 ms | Ack SLO met on a local stack, p95 45–110 ms from 0.17/s to 20/s ([load test](evidence/load-test.md)); the rest A |
| Availability | 99.5%; data loss ≤ 5 min; recovery ≤ 1 h; a missed webhook is recovered by polling | A |
| Data | Relational rows ≈ 36 KB per payment on the webhook path, measured ([load test](evidence/load-test.md); documents separate); money and approvals need strong consistency; traces and analytics may be eventually consistent | A |
| Security / compliance | Synthetic data only (hackathon IP and privacy rules); the repository is public (HackerEarth FAQ) | K: HackerEarth FAQ: all code public; Airwallex rules: submissions must use Airwallex APIs |
| Global | ISO currencies with exponents, UTC storage, per-business time zone, externalised strings, WCAG 2.2 AA | A |
| Budget | Model spend from a $100 grant; infrastructure $5–20/month assumed until the hosting ticket fixes it (`docs/budget.md`); about $1k/month at 100×, dominated by model calls | K/A |
| Feedback loops | Local check ≤ 2 min, pull-request CI ≤ 5 min, environment reset ≤ 2 min | A |
| Model cost | About $0.045 per RFI draft and $0.004 per extracted document (token counts estimated, prices from the provider's pricing page) | A |

## 2. Domain model

Bounded contexts (modules): **Evidence** (documents, extracted facts, evidence rules) · **Payments** (counterparties,
payments, the transfer projection) · **Reviews** (RFIs, questions, drafts, answer memory) · **Approvals** (policy,
bound approvals, execution attempts) · **Planning** (obligations, plans, actions) · **Integration** (webhook inbox,
reconciler, Airwallex adapter) · **Audit** (hash-chained log, agent runs).

Invariants
- A document is immutable (bytes + SHA-256). Extracted facts are versioned and never edited; a correction is a new version.
- Money is an integer in minor units plus an ISO currency; decimal strings exist only at the Airwallex boundary.
- A payment's status is a **projection** of (Airwallex transfer status, open RFI). RFI events never set `SENT`, `PAID` or `FAILED` ([ADR 0006](adr/0006-payment-status-as-projection.md)).
- Every outbound money call is preceded by a persisted `ExecutionAttempt`; an unknown outcome is resolved by lookup, never by a new `request_id` ([ADR 0007](adr/0007-execution-attempts-and-unknown-outcomes.md)).
- An approval is single-use, bound to the exact content shown, and consumed atomically in the same transaction as the attempt ([ADR 0008](adr/0008-bound-approvals.md)).
- A draft answer is immutable and every claim in it is backed by a citation that the verifier has checked ([ADR 0010](adr/0010-grounded-drafting-and-quote-verification.md)).
- The planner is a pure function; held funds are unavailable until measured otherwise.

State machines
- **Payment view** = `project(transferStatus ∈ {IN_APPROVAL, APPROVAL_RECALLED, APPROVAL_REJECTED, APPROVAL_BLOCKED, SCHEDULED, OVERDUE, PROCESSING, SENT, PAID, FAILED, CANCELLED}, openRfi?)`; "held" is a flag. `PAID → FAILED` raises an incident.
- **RFI**: `ACTION_REQUIRED → DRAFTING → DRAFT_READY | NEEDS_OWNER → APPROVED → ANSWER_SUBMITTING → ANSWERED → CLOSED | REOPENED (→ DRAFTING) | EXPIRED`.
- **Approval**: `PENDING → APPROVED | REJECTED | EXPIRED → CONSUMED`.
- **ExecutionAttempt**: `INTENT → SENT_TO_AIRWALLEX → CONFIRMED | UNKNOWN | REJECTED`; `UNKNOWN` is resolved by the reconciler.
- **PlanAction**: `PROPOSED → APPROVED | AUTO_APPROVED → EXECUTING → DONE | FAILED`.
- **Job**: `PENDING → RUNNING → DONE | RETRY → DEAD`.

Events (in-process, from the outbox; versioned): `document.extracted`, `payment.submitted`, `airwallex.transfer.updated`,
`airwallex.rfi.opened | answered | closed | reopened`, `draft.ready`, `approval.granted`, `answer.submitted`,
`plan.revised`, `action.executed`.

## 3. Decisions

| Area | Decision | Why | Rejected alternative | Cost to reverse | ADR |
|---|---|---|---|---|---|
| Architecture style | Modular monolith, npm workspaces `domain`, `db`, `airwallex`, `agent`, `web` | One deployable, pure domain | Microservices | Low | [0001](adr/0001-modular-monolith-and-workspaces.md) |
| Data | PostgreSQL via `DATABASE_URL`, `pg`, Drizzle; integer minor units | Strong consistency for money | Document store | Medium | [0002](adr/0002-postgres-and-money-representation.md) |
| Documents | `bytea` in Postgres, ≤ 5 MB | No second store | Object storage | Medium | [0003](adr/0003-documents-in-postgres.md) |
| API | REST under `/api/v1`, shared zod schemas, idempotency keys on money and approval calls | Documented contract | GraphQL, tRPC | Low | [0004](adr/0004-rest-zod-idempotency.md) |
| Async | Outbox jobs claimed with `SKIP LOCKED` by a worker process; reconcile poll | Duplicated, unordered events; no broker needed at under 1 request/s | Message broker | Low | [0005](adr/0005-outbox-worker-and-reconciliation.md) |
| Payment status | Projection over 11 transfer statuses | Out-of-order events | Stored status machine | Medium | [0006](adr/0006-payment-status-as-projection.md) |
| Money calls | Persisted attempts, lookup before retry | Timeouts must not double-pay | Retry with new id | Low | [0007](adr/0007-execution-attempts-and-unknown-outcomes.md) |
| Approvals | Hash-bound, single-use, atomic consume | R6 | Role-only checks | Low | [0008](adr/0008-bound-approvals.md) |
| AI | Deterministic workflow, three typed model calls, no money tools | R5 | Autonomous agent | Low | [0009](adr/0009-deterministic-workflow-no-money-tools.md) |
| Grounding | Verbatim quote + page verified against the PDF text layer; answer verifier | Catches hallucinated facts | String match on facts | Low | [0010](adr/0010-grounded-drafting-and-quote-verification.md) |
| Autonomy | Auto-FX under daily cap, slippage bound, recorded policy hash | Bounded autonomy | Always ask / unlimited | Low | [0011](adr/0011-auto-approval-policy-limits.md) |
| Security | better-auth, server-side scoping by business, upload and webhook controls | Product has users | Row-level security | Medium | [0012](adr/0012-authn-authz-and-tenancy.md) |
| Audit | Hash-chained append-only log, restricted DB role | Tamper evidence | Trigger only | Low | [0013](adr/0013-audit-log-hash-chain.md) |
| Hosting | One container image, `web` and `worker` modes; platform chosen in a ticket | Platform-neutral | Platform lock-in | Low | [0014](adr/0014-platform-neutral-container-deployment.md) |
| Observability | pino JSON logs, correlation ids, agent-run tables, DB-backed SLO page | Core-flow SLOs | Tracing service | Low | [0015](adr/0015-observability-and-slos.md) |
| Toolchain | TypeScript 5.9.3, pinned exact versions | Newest majors are risky | TypeScript 7 | Low | [0016](adr/0016-typescript-5-9-and-pinned-toolchain.md) |
| Frontend | Next.js App Router, Tailwind, shadcn, strings module + `Intl` | Hero screen, accessibility | SPA, next-intl | Low | [0017](adr/0017-frontend-app-router-and-strings.md) |
| Simulation | `SandboxSimulator` port that calls only real `/simulation/*` endpoints; labelled replay mode | No mocks in the product path | Local fakes | Low | [0018](adr/0018-sandbox-simulator-and-replay-mode.md) |

## 4. System diagram

```
 Owner (browser) ──► Next.js "web" mode ─ UI · /api/v1 · /api/webhooks/airwallex · /status/<token> · /ops · /healthz
                         │
 Airwallex sandbox ◄─ adapter (timeouts, lookup before retry) ◄─ executor ◄─ approvals only
        │ webhooks (HMAC)                           ▲
        ▼                                           │
   webhook_events ─► outbox_jobs ─► "worker" mode: job loop (1 s) + reconcile (60 s)
 Anthropic API ◄─ agent package: 3 typed calls + verifier (no tools, no keys, no money)
 PostgreSQL: documents · facts · payments · RFIs · drafts · approvals · attempts · plans ·
             outbox · webhook events · audit (hash chain) · agent runs
 Trust boundaries: browser | Airwallex (HMAC) | documents and RFI text (untrusted data) | model → executor (approvals only)
```

## 5. Data model

All tables carry `business_id` (tenant) except provider-level tables. Money columns are `*_minor bigint` + `currency char(3)`.

| Table | Key columns |
|---|---|
| `businesses` | id, name, timezone, reserve_floor (per currency), policy_version |
| `users` | id, business_id, email, role (owner / approver / viewer); credential tables from the auth library |
| `documents` | id, business_id, kind, filename, mime, size, sha256, bytes, created_at |
| `document_facts` | id, document_id, version, prompt_version, model, facts, quotes (text + page), quotes_verified, owner_confirmed_by |
| `counterparties` | id, business_id, name, country, beneficiary_id, account_fingerprint |
| `obligations` | id, business_id, counterparty_id, amount_minor, currency, due_at, criticality, criticality_confirmed_by, payment_id |
| `payments` | id, business_id, obligation_id, amount_minor, currency, source_currency, method, reference, transfer_id, transfer_status, transfer_updated_at, failure_type |
| `evidence_links` | payment_id, document_id, fact_version_id |
| `rfis` | id, business_id, airwallex_rfi_id, status, state, expires_at, payment_id (nullable), airwallex_updated_at, round |
| `rfi_questions` | id, rfi_id, airwallex_question_id, title, description, answer_type, sources, round |
| `drafts` / `draft_answers` | draft: id, rfi_id, round, prompt_version, model · answer: id, draft_id, question_id, text, citations, verifier_result, status |
| `answer_memory` | id, business_id, counterparty_id, fingerprint (normalised question), answer_text, citations, source_approval_id |
| `approvals` | id, business_id, kind, subject_ref, hash, nonce, approver_id, status, expires_at, consumed_at, shown_snapshot |
| `policies` / `auto_approvals` | policy: id, business_id, version, hash, content · auto approval: id, action_id, policy_version, policy_hash, daily_total |
| `plans` / `plan_actions` | plan: id, business_id, revision, inputs_hash, explanation · action: id, plan_id, kind, params, status, approval_id or auto_approval_id |
| `execution_attempts` | id, kind (transfer / conversion / respond), ref_id, request_id, status, response, created_at, resolved_at |
| `webhook_events` | id, provider_event_id (unique), name, received_at, raw_body, signature_ok, processed_at |
| `outbox_jobs` | id, kind, payload, status, attempts, run_after, locked_at, last_error |
| `idempotency_keys` | key, endpoint, request_hash, response, created_at (money and approval endpoints only) |
| `agent_runs` / `agent_steps` | run: id, kind, ref, status, tokens, cost, started/finished · step: id, run_id, step, prompt_version, model, input_hash, output, latency_ms, stop_reason |
| `audit_log` | id, prev_hash, hash, at, actor_type, actor_id, action, subject, data |
| `payee_links` | id, payment_id, token_hash, expires_at, disclosure_level, revoked_at |
| `system_flags` | agents_enabled, execution_enabled, daily_spend_cap, per_run_cap |
| `rate_limits` | key, window_start, count |

Indexes follow the core queries: `payments(business_id, transfer_status)`, `rfis(business_id, state)`, `outbox_jobs(status, run_after)`, `webhook_events(provider_event_id)`, `execution_attempts(request_id)`, `answer_memory(business_id, counterparty_id, fingerprint)`.
Migrations use drizzle-kit; the application connects with a role that cannot alter the audit table or its constraints ([ADR 0013](adr/0013-audit-log-hash-chain.md)).

## 6. Events and real-time
- A webhook is verified (HMAC over the raw body, constant-time compare, five-minute freshness window), stored with its job in one transaction, and acknowledged. The worker never trusts the payload's status: it fetches the object and applies it only if it is not older than what is stored.
- Delivery is at-least-once: consumers are idempotent (unique provider event id, attempt rows). Reconciliation polls `GET /rfis` and open transfers every 60 s and resolves `UNKNOWN` attempts.
- The UI polls every 3 s on screens that wait for an event.

## 7. Data and consistency
Postgres is the system of record for every entity. Money, approvals, attempts and idempotency choose consistency over availability (single primary); UI reads can lag by one poll interval. Backups and point-in-time recovery depend on the hosting platform and are an acceptance criterion of the hosting ticket. Documents and traces are retained 90 days in the demo; the audit log indefinitely.

## 8. Security (threat model, STRIDE on the core flow)
| Threat | Example | Control |
|---|---|---|
| Spoofing | Forged Airwallex webhook | HMAC over raw body, timestamp freshness, constant-time compare, de-duplication; fetch-before-trust |
| Spoofing | Stolen session | better-auth sessions, rate-limited login, server-side authorisation |
| Tampering | Changing an answer between approval and submit | Approval hash covers exact text, attachment hashes and RFI version; atomic consume; executor re-derives the hash and re-reads state |
| Tampering | Editing audit history | Hash chain, verified on `/ops`; restricted DB role |
| Repudiation | "I never approved that" | Approval and audit records with approver id, nonce, shown snapshot |
| Information disclosure | Payee page reveals a compliance hold | Generic status by default; owner opt-in; hashed token, expiry, `no-referrer`, `noindex`, rate limit |
| Information disclosure | Prompt injection exfiltrates data | Models have no tools or credentials; documents are untrusted data; output schema and verifier |
| Denial of service | Webhook flood, upload abuse | Rate limits, size and page limits, job back-pressure |
| Elevation of privilege | Cross-tenant access | Every repository call scoped by `business_id`; tests for cross-tenant reads |
| Elevation of privilege | Prompt-injected plan action | Criticality is owner-confirmed; money actions need a bound approval or a policy-bound auto-approval |

Uploads: magic-byte validation (PDF, JPEG, PNG), 5 MB default cap, PDF ≤ 20 pages, filenames sanitised to ≤ 50 characters, served with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, no URL fetching anywhere (no SSRF surface), bytes re-hashed before they are sent and compared with the approved hash.
Secrets live in the platform's environment (marked sensitive) and in `.env` locally; the model never sees any. CI runs a secret scan and dependency audit.

## 9. Reliability, observability and SLOs
- Every outbound call has a timeout (Airwallex 10 s, model 60 s); retries use backoff with jitter and honour `retry-after`. Money calls follow the attempt/lookup protocol.
- Degradation: model unavailable → drafting becomes `NEEDS_OWNER` (the owner writes the answer); Airwallex unavailable → the plan shows a stale banner and execution waits.
- Circuit-breaker state is derived from recent job failures in the database, not from process memory.
- **Operator note: switches, caps and breakers (M4-02).** Owner-only controls on `/ops` (`POST /api/ops/flags`, audited with actor, old and new value, reason). Read fresh from `system_flags` at every decision point, never cached; an unreadable row counts as off.
  - **Pause agents** (`agents_enabled=false`): flip it when the model misbehaves, a prompt-injection is suspected, or spend is running away. No new model call starts (the harness records a zero-cost `killed` step); drafts and extractions degrade to `NEEDS_OWNER` and an incoming RFI is still ingested for the owner to answer by hand. Planner, approvals and the reconciler keep running.
  - **Pause execution** (`execution_enabled=false`): flip it when a payment path looks wrong or an Airwallex incident is open. No new `ExecutionAttempt` of any kind is created (`createAttempt` refuses, `consumeApproval` refuses), mutating jobs wait, and pending approvals end as `EXPIRED / KILL_SWITCH`; they stay ended after resuming, so the owner approves again against current state. Attempts already past `INTENT` (`SENT_TO_AIRWALLEX`, `UNKNOWN`) continue to resolution: the reconciler only looks up, so a paused system never abandons an unknown outcome.
  - **Spend caps**: `system_flags.per_run_cap_minor` and `daily_spend_cap_minor` (USD cents; seeded 100 and 1000, the `.env.example` defaults `MODEL_PER_RUN_CAP_USD` and `MODEL_DAILY_SPEND_CAP_USD`). Before each model call the harness prices the worst case (input bytes plus `max_tokens`) against the run and the UTC day; a breach sends nothing, records a `spend_cap` step and degrades drafting to `NEEDS_OWNER`. The day is 00:00 to 24:00 UTC. Raise a cap by updating the row with the migration role; the page shows today's spend and both caps.
  - **Circuit breakers** (Airwallex, model): `CLOSED`, `OPEN`, `HALF_OPEN` computed from `outbox_jobs` (RETRY/DEAD vs DONE of Airwallex job kinds) and `agent_steps` (`provider_error` vs other outcomes) inside a window: `BREAKER_FAILURE_THRESHOLD` (5), `BREAKER_WINDOW_SECONDS` (300), `BREAKER_COOLDOWN_SECONDS` (60). OPEN defers new jobs for that dependency with jittered delay (no attempt spent); after the cool-down one probe goes through and a success closes it. The reconciler is exempt. Nothing to flip: investigate the dependency, not the breaker.
- Single points of failure: the database (platform backups) and the single worker (restart policy, health check; the reconciler recovers after restart because all state is in Postgres).
- Logs: pino JSON to stdout with correlation ids (request, event, RFI, run). Metrics are derived from the database timestamps and shown on `/ops`.
- SLOs on the core flow: webhook acknowledged p95 < 300 ms warm · `rfi.action_required` to draft ready p95 < 60 s · approval to RFI answered p95 < 30 s · zero payments marked `SENT`/`PAID` from an RFI event alone.

## 10. Agent architecture
- **Shape**: a deterministic workflow. The model performs three typed, schema-constrained calls and has no tools, keys or write access ([ADR 0009](adr/0009-deterministic-workflow-no-money-tools.md)): extract facts from a document (small model), propose a criticality from a contract (large model), draft answers to RFI questions (large model).
- **Guardrails**: input — documents, RFI text and prior answers are untrusted data in delimited blocks, an injection pre-scan flags suspicious content for owner review; output — JSON-schema-constrained, then verified in code; action — the executor accepts only an approval whose hash matches current state, or a policy-bound auto-approval.
- **Circuit breakers**: at most two model calls per question, token and time limits per call, per-run and daily spend caps stored in `system_flags`; model outputs are stored per step so a crashed run replays the stored output.
- **Governance**: the agent has its own identity in the audit log; human approval is always required for RFI answers and payouts; FX conversions may auto-execute under the policy limits ([ADR 0011](adr/0011-auto-approval-policy-limits.md)); kill switch (`agents_enabled`, `execution_enabled`) stops new model calls and executions and invalidates pending approvals, while in-flight attempts continue to resolution; the audit log is append-only and hash-chained.
- **Evals** (run in CI when prompts, schemas or the verifier change): at least 40 ground-truth cases, trajectory checks, adversarial cases (instructions hidden in documents, contradictory documents, missing documents, follow-up reuse) and a mutation set in which wrong numbers, dates or names are injected into good drafts and must be rejected 100% of the time.

## 11. On-chain
Not applicable.

## 12. Scaling story and cost at 100×
- Traffic (corrected by the M4-06 load test, [evidence](evidence/load-test.md)): one sandbox payment produced 7 `payout.transfer.*` webhook events in the recorded M2-09 run, not 3, and an RFI round adds about 2. 5,000 payments/day × 7 plus 500 RFIs × 2 is about 36,000 events/day: 0.42 requests/s on average and about 4/s at a 10× peak, against the Airwallex sandbox limit of 20/s. On a local laptop stack, webhook ack p95 stayed between 45 and 110 ms from 0.17/s to 20/s; the web tier is stateless and scales horizontally, the worker can run several instances because jobs are claimed with `SKIP LOCKED`.
- Storage (corrected, measured): about 36 KB of relational rows per payment on the webhook path (25 KB of it is `webhook_events`, mostly raw bodies) is about 182 MB/day (about 67 GB/year) at 100×. That needs a paid database plan and a retention rule for raw webhook bodies. The figure leaves out creation-side rows (approvals, execution attempts, evidence), so it is a lower bound; documents then move to object storage (trigger recorded in ADR 0003).
- Model cost: about $0.045 per RFI draft × 500/day ≈ $22/day, plus about $0.004 per document; mitigations are the small model for the first pass, prompt caching and batch pricing for extraction.
- Monthly cost at 100×: platform and database in the tens of dollars to low hundreds, model spend about $1k/month.

## 13. Not built (and the trigger that would add it)
Microservices or Kubernetes (separate scaling profiles) · a message broker (throughput beyond the Postgres job table) · a cache layer (a measured hot read) · a vector database (answer memory beyond 10,000 entries; Postgres text search until then) · Postgres row-level security (a second application writing to the database) · a policy engine (policies that change without deploys) · a tracing service (more than one deployable) · Terraform (more than about ten cloud resources) · object storage (100× scale) · a PII vault (real customer documents) · multi-region database (a non-US latency target).
