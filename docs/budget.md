# Budget

Owner: M0-00 (this file) · Hosting section: M0-07 fills it from provider pages fetched that day.
Every figure below is an **assumption** unless a source is cited; `M0-06` re-measures model cost and
this file is corrected from the measured numbers. Nothing is bought without the owner's approval.

## Purchases decision
**Buy nothing** except the hosting plan chosen in M0-07, and only within the cash ceiling below.
No domain (the platform's HTTPS hostname is enough), no paid design, CI, monitoring or video tools,
no paid Claude subscription (the build uses the Console API key with the hackathon grant),
no Airwallex production account.

## Cost table (assumptions)

| Item | Unit | Build window (2-15 Nov) | Judging window (to 30 Nov, assumed) | Basis |
|---|---|---|---|---|
| Airwallex sandbox | free | $0 | $0 | PROJECT.md §5 |
| GitHub (repo, Actions) | public repo, free minutes | $0 | $0 | public at submission; private-repo minutes are within the free plan (unverified) |
| Anthropic model API | per million tokens: Haiku 5.5 $0.10 in / $0.50 out; Sonnet 5.5 $2 in / $10 out | about $31 (below) | about $5 | PROJECT.md §4 prices; token counts are assumptions |
| Hosting (web + worker + Postgres) | month | $5-20 assumed | $5-20 assumed | PROJECT.md §5; **unverified**, M0-07 replaces with sourced prices; $0 if AWS credits are granted (P-12) |
| Logging / tracing | stdout logs on the host | $0 | $0 | no extra service (engineering standards) |
| Domain, video host, other | - | $0 | $0 | YouTube unlisted or equivalent is free |

### Model spend plan (assumed token counts; M0-06 replaces them)
| Activity | Count | Per unit | Cost |
|---|---|---|---|
| Extraction, Haiku (8k in / 1k out per document) | 500 docs | $0.0013 | $0.65 |
| Criticality, Sonnet (15k in / 1.5k out) | 100 runs | $0.045 | $4.50 |
| Drafting, Sonnet (20k in / 3k out) | 200 dev runs | $0.07 | $14.00 |
| Eval suite (M4-03): 40+ cases, 3 runs, plus mutation checks | about 120 drafts | $0.07 | $8.40 |
| Demo rehearsals and recorded real runs | 30 full runs | $0.12 | $3.60 |
| **Subtotal** | | | **$31.15** |
| Contingency 50% | | | $15.60 |
| **Build-window plan** | | | **about $47** |
| Judging window: owner live runs; judges use replay and cost nothing (M4-05) | | | about $5 |
| **Total model spend** | | | **about $52 of the $100 grant** |

Enforcement in the product: `MODEL_PER_RUN_CAP_USD` (proposed $0.50), `MODEL_DAILY_SPEND_CAP_USD`
(proposed $10), `SESSION_MODEL_CAP_USD` for judge sessions (M4-05), all checked before each call (M4-02).
Outside the product: the Console spend limit (P-18) set to the approved model-spend ceiling.

## Totals
| | Cash (out of pocket) | Model grant used |
|---|---|---|
| Development (2-15 Nov) | $10 assumed (hosting) | about $47 |
| Judging window (to 30 Nov) | $20 assumed (hosting) | about $5 |
| **Proposed ceiling the owner approves** | **$40 cash** (hosting both windows, with headroom) | **$60 of $100 grant** |

If hosting turns out to cost more than the cash ceiling in M0-07, the decision returns to the owner;
no worker upgrades a plan on its own. The grant is first-party API only, one claim, 90 days
(PROJECT.md §1); credits take 1-2 business days to arrive, so P-04 gates M0-06.

## Budget alerts that enforce the ceiling
1. Claude Console organisation spend limit at the approved model-spend ceiling (P-18).
2. Hosting platform budget or usage alert at 50% and 80% of the cash ceiling (set in M0-07).
3. The in-product caps above and the kill switch (M4-02).
4. `/ops` shows model spend to date from `agent_runs.cost` (M1-09, M4-02).

## Hosting (filled by M0-07)
Railway, Render and AWS: comparison rows with source URL and date per cell go here. Until then the
only number in this file for hosting is the PROJECT.md §5 assumption of $5-20 a month.
