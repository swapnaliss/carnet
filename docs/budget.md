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

## Hosting (filled by M0-07, fetched 3 Nov 2026)
Every cell cites its page, all fetched on 3 Nov 2026. "unverified" means the figure was not on a page I could
fetch that day; none is guessed. Render's pricing page is rendered by JavaScript and returned no table, so its
paid prices are unverified until the owner reads them in the dashboard create form.

| Field | Render | Railway | AWS |
|---|---|---|---|
| Free tier or trial, expiry | Hobby workspace has no monthly fee ([faq](https://render.com/docs/faq)). Free web service: 750 free instance hours a month per workspace. Free Postgres: 1 GB, **expires 30 days after creation**, 14-day grace, then deleted ([free](https://render.com/docs/free)) | Free Trial: $5 one-time credit, expires after 30 days; Free: $1 a month; Hobby: $5 a month with $5 usage included ([pricing](https://railway.com/pricing)) | "up to $200 in credits": $100 at once, up to $100 more for exploring services; up to 6 months; free-plan account closes after 6 months or when credits run out ([free](https://aws.amazon.com/free/)) |
| Sleep on idle | Free web service spins down after 15 minutes without inbound traffic, about one minute to wake; paid services do not sleep ([free](https://render.com/docs/free)) | "a service sleeps somewhere between 5 and 10 minutes after its last outbound traffic"; which plans or services this applies to is not stated ([app-sleeping](https://docs.railway.com/reference/app-sleeping)) | App Runner provisioned instances keep the app warm; services can be paused ([apprunner pricing](https://aws.amazon.com/apprunner/pricing/)) |
| Managed Postgres: price, size, versions | Plans from `0.1c-256mb` up; versions 13 to 18; storage 1 GB or multiples of 5 GB ([plans](https://render.com/docs/compute-plans), [creating](https://render.com/docs/postgresql-creating-connecting)). **Monthly prices unverified.** | Single-node template on the official Postgres image; versions not listed; volumes 0.5 GB Free/Trial, 5 GB Hobby, 50 GB Pro ([postgresql](https://docs.railway.com/databases/postgresql), [volumes](https://docs.railway.com/reference/volumes)). Priced by usage: memory about $10 per GB a month, volume about $0.15 per GB a month ([pricing](https://railway.com/pricing)) | RDS Free Tier "750 hours on a selection of Single-AZ instance databases" for one year, 20 GB gp2 storage, 20 GB backup storage ([rds pricing](https://aws.amazon.com/rds/postgresql/pricing/)). **Instance and storage prices unverified.** |
| Backups, point-in-time recovery | Paid plans: PITR past 3 days (Hobby) or 7 days (Pro workspace); logical exports kept 7 days. Free plan: neither ([backups](https://render.com/docs/postgresql-backups)) | Native Backups and a separate point-in-time recovery option exist; plan limits and price unverified ([postgresql](https://docs.railway.com/databases/postgresql)) | Automated backups billed beyond the free 20 GB; retention range and PITR not on the page: unverified |
| Always-on background worker | Supported as a paid service type; no free worker ("Other service types don't support Free instances"); plans `0.5c-512mb` (legacy Starter) and up ([free](https://render.com/docs/free), [plans](https://render.com/docs/compute-plans)). **Price unverified.** | Services run continuously; worker price is usage-based, about $20 per vCPU and $10 per GB a month ([pricing](https://railway.com/pricing)); sleep behaviour for workers not stated | App Runner has no worker type documented on its page; ECS Fargate not fetched: unverified |
| Regions | Oregon, Ohio, Virginia, Frankfurt, Singapore ([regions](https://render.com/docs/regions)) | US West (California), US East (Virginia), EU West (Amsterdam), Southeast Asia (Singapore) ([regions](https://docs.railway.com/reference/regions)) | not fetched: unverified |
| Custom domain and HTTPS | Additional domains $0.25 each a month ([faq](https://render.com/docs/faq)); HTTPS on the default hostname: unverified until the placeholder answers | not on the fetched pages: unverified | not fetched: unverified |
| Deploy from Docker image or Git | Prebuilt image from any public registry, or private from Docker Hub, GHCR, GitLab, Google Artifact Registry, ECR ([deploy-an-image](https://render.com/docs/deploy-an-image)); Git-backed Docker build needs Render's GitHub access to the repo (observed 3 Nov: the CLI rejects the private repo URL as "invalid or unfetchable") | not on the fetched pages: unverified | not fetched: unverified |
| Log retention | Hobby 7 days, Pro 14 days ([logging](https://render.com/docs/logging)) | Trial 7 days, Free 3 days, Hobby 7 days, Pro 30 days ([pricing](https://railway.com/pricing)) | not fetched: unverified |
| Monthly cost, web + worker + Postgres, build period and judging window | unverified (paid prices not fetchable); the free web service and free Postgres cost $0 but sleep, have no worker and no backups | about $5 plan plus usage; the sum for our scale is unverified | $0 within credits if granted and eligible; sum unverified |

### Recommendation
Render, which is the owner's choice (3 Nov 2026), meets the ADR 0014 contract: a Docker build from the M0-02
Dockerfile, a managed Postgres with point-in-time recovery on paid plans, a paid background worker type, a
`healthCheckPath`, a public HTTPS hostname and the Singapore region. The web service must be a paid instance,
because a free one sleeps after 15 minutes and would miss webhooks and stall the worker. The free Postgres has no
backups and expires 30 days after creation (created on 3 Nov that is 3 Dec, after the judging window) so it is
only a fallback if the paid price does not fit. Railway is the closest alternative; AWS is only worth it if
the organisers grant credits (P-12). **Before any paid resource is created, the owner reads the three monthly
prices in Render's create form and confirms the total is within the $40 cash ceiling**; until then the cost
row stays "unverified" and nothing billable is created.
