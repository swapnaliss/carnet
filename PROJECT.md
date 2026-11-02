# PROJECT — Carnet

Internal spec for the build. The public system design is [`docs/architecture.md`](docs/architecture.md); each decision is an ADR in [`docs/adr/`](docs/adr/); standards for every ticket are in [`docs/engineering-standards.md`](docs/engineering-standards.md). Research is in `docs/research/` (gitignored).

## 1. Hard facts (re-verified 2 Nov 2026; sources in `docs/research/RESEARCH.md` §2 and `.kickoff-state.md`)

| Fact | Value |
|---|---|
| Event | Airwallex Agentic Banking Hackathon, hosted on HackerEarth; builder lab airwallexdev.com |
| Owner status | Idea accepted (shortlist emails 27 Oct 2026); Slack workspace joined |
| Build phase | Starts 27 Oct 2026 04:30 UTC |
| **Submission due** | HackerEarth event data: **15 Nov 2026 18:29 UTC (23:59 IST)**. Landing page still says 13 Nov. The owner plans against 15 Nov; the plan is submission-ready on 14 Nov. Confirm in Slack (`M0-01`) |
| Finalists / Demo Day | 15 Nov / 19 Nov 2026, San Francisco, remote participation optional |
| Prizes | Founder's Choice $30,000 and Judges Choice $20,000 (open categories, "No specific requirements"); Visa Award $15,000 and Metal Award $15,000 (need Visa or Metal tooling: not targeted). Credits: Claude $10,000 pool ($100 per accepted builder, one claim, 90-day validity, first-party API only), AWS $50,000, Base44 $16,000 |
| Tracks | 12 starter kits; own ideas allowed ("Take one as written, change it, or apply the criteria in Build around a financial decision to your own idea"). Carnet: own idea, closest to Kit 3 (Payment Ops Incident Commander) with Kit 1's decisions |
| Rubric | **Not published.** De facto rubric from the builder guide (below, §7). Forum request for it was unanswered |
| Submission artefacts | "A working demo, a short video walkthrough under five minutes, and a link to your repository with setup instructions." (HackerEarth's generic FAQ also mentions a zip upload and says a video is not mandatory; make all of them) |
| Disqualifying rules | Submissions must use Airwallex APIs ("A submission that does not include use of Airwallex APIs will not be considered", organiser reply in the forum); code must be public (HackerEarth FAQ: "all code needs to be in public domain (open source)"); team of at most four; entrants 18 or older |
| IP | "You retain full ownership of your project. Submitting only grants us permission to showcase your work" |
| Prior work / AI use | Prior-work rule unanswered; AI tools not restricted. Carnet's code is written inside the build window |
| Tech constraints | Airwallex sandbox only; REST `https://api.sandbox.airwallex.com/api/v1`; 30-minute token; amounts in major units; `request_id` unique for 7 days; 20 requests/s global, 10 per endpoint, 10 concurrent |
| Support | The hackathon Slack workspace (not devhelp email, per the organiser); support@hackerearth.com for the platform |
| Open questions for organisers | Final deadline (13 vs 15 Nov); rubric; AWS credits; whether a plain sandbox account can create simulated RFIs; whether one project can win two prizes; prior-work wording; payout details for India |

## 2. Product

**Carnet** makes a cross-border payment survive Airwallex's risk review: it checks evidence before a payment moves, drafts answers to Transaction RFIs from the owner's documents for one bound approval, and re-plans payroll and supplier payments while a payment is held.

**Pain evidence** (quotes verified in `docs/research/`):

| Problem | Evidence | Who suffers |
|---|---|---|
| Payments held after an inbound client payment, with payroll due | r/smallbusiness, 2025-12-11: "Yesterday a client paid an invoice and my account got locked. They asked for proof of funds. I uploaded the contract and invoice straight away. That was 2 days ago." and "I have payroll due on Friday for my team." | Founder-operators of small agencies |
| Repeated requests for the same documents | r/smallbusiness, 2025-10-17: "I currently have €50,000 frozen, with no access, no refund date, and no concrete explanation." and "six different agents… Each one asked for the same documents again, just worded differently" | Owners of cross-border businesses |
| Suppliers chase a payment nobody can see | r/smallbusiness, 2026-04-02: "Vendors follow up asking if payment was sent, I confirm it was, we both wait." | Finance leads at importers |
| What the review asks for | Airwallex docs: requests are "commonly a request for supporting documents relating to the transaction itself such as invoices or contracts to support the underlying fund movement" | All Airwallex customers |

Inference (labelled): the pain is provider-wide; only Airwallex's RFI API is demonstrable in the sandbox. Airwallex ships RFI answering screens (embedded component, hosted flow, console) but no automation; a GitHub search for Airwallex RFI projects found none among the hackathon entries.

**Users:** founder-operator of a 5–30 person cross-border agency; part-time finance lead at an importer; solo exporter. Buyer and user are the same person; a bookkeeping firm could buy for many clients.

**Core journey:** state the goal ("payroll and two suppliers by Friday") → evidence check per payment → approve and send → one payment is held (RFI) → cited drafts → one bound approval → answer submitted → plan revised (convert, alternate payout, defer) → outcome tracked on the transfer's own status → a follow-up round reuses approved answers.

**Demo storyboard (≤ 3 minutes):** 0:00 pain (quoted) · 0:25 goal, plan and evidence flags (one weak) · 0:50 two payments clear, one sent · 1:10 an RFI arrives from the real sandbox, the payment shows HELD FOR INFORMATION and the plan re-runs · 1:30 drafted answers with cited documents, bound approval, submit · 2:05 the revised plan executes (a conversion auto-executes under its limit, an alternate payout needs approval), the transfer reaches SENT or PAID on its own status · 2:25 a follow-up reopens a question and the approved answer is reused in one click · 2:45 limits and future vision. The core milestone (M2) makes steps up to submission run for real; M3 completes the storyboard.

**Success metric:** (a) at least 95% of eval-set RFI questions answered with every claim grounded, and 100% of mutated drafts rejected; (b) zero payments marked sent or paid on an RFI event alone (invariant test); (c) payroll funded in the revised plan (scenario test); (d) event-to-draft p95 < 60 s from run traces.

**Pillars:** (1) evidence-first payments (pain: re-uploading documents) · (2) bound-approval RFI answers (pain: six agents asked for the same documents) · (3) hold-aware planning (pain: payroll due Friday) · (4) governed execution and audit (pain: nobody trusts an agent with money).

## 3. Architecture
See [`docs/architecture.md`](docs/architecture.md).

## 4. Tech stack (versions checked against the npm registry on 2 Nov 2026)

| Layer | Choice | Version | Why |
|---|---|---|---|
| Runtime | Node.js | 24.x (local 24.22.1) | Current LTS line; `unpdf` needs ≥ 24 |
| Language | TypeScript | 5.9.3 | New majors are too risky for a 13-day build (ADR 0016) |
| Web | Next.js, React | 16.4.3, 19.3.1 | App Router, server components |
| Styling | Tailwind CSS, shadcn | 4.3.3 | Design tokens, accessible components |
| Database | PostgreSQL (`postgres:17-alpine` locally), `pg`, Drizzle ORM, drizzle-kit | pg 8.23.1, drizzle-orm 0.45.4, drizzle-kit 0.31.11 | Portable; Drizzle 1.0 is still a release candidate |
| Validation | zod | 4.6.7 | Shared schemas |
| Model | Anthropic SDK; `claude-haiku-5-5` (extraction), `claude-sonnet-5-5` (criticality, drafting) | 1.3.0 | Structured outputs, PDF input; pin exactly (1.0 shipped 21 Oct 2026) |
| PDF | `unpdf` (text layer), `pdfkit` (synthetic documents) | 2.1.0, 0.20.2 | Maintained; `pdf-lib` is unmaintained |
| Auth | better-auth | 1.7.15 | No extra account |
| Logging | pino | 10.4.0 | Structured JSON |
| Tests | Vitest, Playwright | 5.0.5, 1.64.1 | Unit, integration, end to end |
| Lint/format | Biome | 2.6.4 | One tool |
| Packaging | Docker (multi-stage), npm workspaces | npm 11.19.1 | Platform-neutral (ADR 0014) |

Every version is re-checked by `M0-02` before install. Provider prices per million tokens: Haiku 5.5 $0.10 in / $0.50 out, Sonnet 5.5 $2 in / $10 out.

## 5. Services and spend
Buy nothing now. Airwallex sandbox: free. Anthropic: $100 grant (one claim). Hosting: Railway, Render or AWS (credits if granted) decided in `M0-07`; assumed $5–20/month. Full budget and judging-window totals are made by `M0-00` in `docs/budget.md`.

## 6. Data model
See [`docs/architecture.md`](docs/architecture.md) §5.

## 7. Deliverables mapped to the rubric

| Criterion (de facto rubric, builder guide "Build around a financial decision") | Deliverable | Tickets |
|---|---|---|
| R0 Uses Airwallex APIs (mandatory) | Adapter for transfers, beneficiaries, balances, FX, RFI, files, webhooks, simulation | M0-03, M0-04, M1-03 |
| R1 A repeated task with a real decision | Payment and RFI decision loops | M2-04, M2-05 |
| R2 The decision changes with new information | Planner re-runs on every event | M3-02, M3-03 |
| R3 Moves money or state, approvals stated | Executor, policy table, approvals | M2-07, M3-03 |
| R4 Demo arc | Storyboard run for real | M2-09, M3-07, M5-02 |
| R5 Code enforces, model judges | Pure domain core; three typed model calls | M1-01, M2-00, M2-02, M2-05 |
| R6 Typed tools, bound approvals | Hash-bound approvals, attempts | M2-07 |
| R7 Simulation behind one interface | `SandboxSimulator` port | M1-03 |
| R8 Differentiation and product | README, future vision, unclaimed niche | M5-01 |
| R9 Artefacts (mandatory) | Working demo, video under 5 minutes, public repo with setup instructions | M5-01..M5-03, M5-SUBMIT |

**UX design workflow:** `M1-07` produces the design system and hero-screen specs (the `ux-designer` agent, output in `docs/design/`); every frontend ticket builds to them and passes the independent `ui-reviewer` (design review in `/start`).

## 8. Milestone plan (IST, pacing only; hours are focused-human estimates)

| Milestone | Delivers | Due | Tickets | Hours |
|---|---|---|---|---|
| M0 · Recon & Bootstrap | Prerequisites, Airwallex and Anthropic spikes with recorded fixtures, hosting decision, repo, CI, synthetic dataset | 4 Nov | 10 | 35 |
| M1 · Walking Skeleton | A thin slice through every layer, deployed | 6 Nov | 11 | 57 |
| M2 · Evidence to Answer | Documents, extraction, RFI intake, cited drafts, bound approval, hold screen; storyboard steps up to submission run for real | 9 Nov | 11 | 67 |
| M3 · Hold-Aware Planning | Planner, auto-FX caps, payouts, follow-up round, payee page; full demo runs for real | 11 Nov | 8 | 43 |
| M4 · Governance & Evals | Audit chain, kill switch, evals, security tests, judge replay mode, load test | 13 Nov | 8 | 42 |
| M5 · Submission | README, video, cleanup, clean-clone gate, submit | 14 Nov (15 Nov buffer) | 6 | 19 |

Total 263 hours for 54 tickets plus the backlog ticket. Capacity at 8 hours a day from 3 to 14 Nov is about 96–104 hours; the plan needs about 22 hours a day if run in sequence and about 11 hours a day on the longest dependency chain even with unlimited workers. Nothing is cut or deferred: the owner chose the pace; estimates are re-measured after M0.

## 9. What this does not do
- Does not unfreeze accounts or bypass any provider's risk review.
- Does not submit an answer or move a payout without a bound approval; only FX conversions under policy limits may auto-execute.
- Does not contact payees or any third party.
- Sandbox only; no real money, no real customer documents.
- Covers Airwallex RFIs only; other providers are future vision.
- Behaviours that are unverified until the M0 spikes: whether a plain sandbox account can create simulated RFIs, how held funds appear in balances, which attachment types Airwallex accepts, whether partial answers are accepted.

### 9.1 Data policy
- **Real:** the Airwallex sandbox account, its API (transfers, beneficiaries, balances, FX, RFIs, file uploads, webhooks, simulation endpoints), the model API, the recorded responses used as test fixtures.
- **Synthetic:** the demo business, counterparties, bank-style details, invoices, contracts and every document (generated by a script with ground truth). No real personal data is stored (privacy law and hackathon IP rules).
- **No mocks or demo mode in the product path.** Tests replay recorded real responses. The judge login serves a replay of a recorded real run, labelled as a recording.
- **Upgrade path to real data:** consent, a PII vault, object storage, retention policy and a lawful basis per jurisdiction; none is built.

## 10. Risk register
| Risk | Impact | Mitigation |
|---|---|---|
| A plain sandbox account cannot create simulated RFIs | The core demo has no RFI | M0-04 spike first; fallback: local injection of the documented webhook shape through the same signature check, labelled in the UI and README |
| Only one Transaction RFI may be open at a time | Parallel demos collide | Sequential demo; exclusive `AIRWALLEX_SANDBOX` resource in `resources.json`; concurrency fixture test |
| Respond may reject partial answers; attachment types unknown | Submitting fails | Every question is answered or the RFI stays NEEDS_OWNER; always upload PDF or JPEG; spike 2 and 3 |
| Held funds are not visible in balances | Plans over-commit cash | Treat held funds as unavailable; spike 8; executor re-reads balances |
| Timeouts or crashes around money calls | Double payment | Persisted attempts and lookup before retry (ADR 0007) |
| Hosting undecided until `M0-07` | Webhook URL late | Polling works without a tunnel; decision in M0 |
| New majors in the toolchain | Lost days | TypeScript 5.9.3, exact pins, a toolchain smoke test in `M0-02` |
| Deadline unclear (13 vs 15 Nov) | Compressed schedule | Plan submission-ready 14 Nov; ask in Slack |
| Anthropic rate limits on a new organisation unverified | Throttled demo | Check the console in `M0-06`; SDK backoff; small model for the first pass |
| Public repo leaks a secret | Credits drained | `.env` gitignored, secret scan in CI and landing checks |
| Prior-work and AI-use rules unanswered | Disqualification risk | Code written inside the build window; question in `M0-01` |

## 11. Future vision
Other providers' information requests (Wise, Payoneer, Stripe) through the same evidence model; accountants managing many small clients; account-level and onboarding reviews; a payment-readiness score before sending.

## 12. Conventions
- Branches: `m<n>-<nn>-<slug>` (one per ticket); CI must be green before a merge (enforced by the workflow commands, not by branch protection).
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`). **No Claude co-author line in commits** (profile `commit_conventions`).
- Identity: `swapnaliss <swapnalisbhargude123@gmail.com>`, set locally.
- Ticket ids `M<n>-<nn>`, `M<n>-GATE`, `BL-01` are permanent once issues exist; milestones are `M<n> · <Stage>`.
