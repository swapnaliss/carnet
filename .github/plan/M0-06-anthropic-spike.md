---
title: "M0-06 · Anthropic spike: structured outputs (SDK 1.3 + zod), PDF extraction with verbatim quotes, rate limits, cost; fixtures"
milestone: "M0 · Recon & Bootstrap"
labels: ["recon", "agent"]
blocked_by: ["M0-02", "M0-08"]
estimate: "4h"
resources: ["ANTHROPIC"]
needs: []
---

## Context

Rubric R5 (code enforces, the model judges) and ADR 0009 (deterministic workflow, no money tools) and ADR 0010 (grounded drafting and quote verification) assume: typed model calls with schema-validated output, and facts that carry a verbatim quote and page checkable against the PDF text layer. PROJECT.md §10 lists "Anthropic rate limits on a new organisation unverified" and the $100 grant is the entire model budget (`MODEL_PER_RUN_CAP_USD`, `MODEL_DAILY_SPEND_CAP_USD` in `.github/plan/resources.json`). SDK 1.x shipped 21 Oct 2026, so we prove the API surface before M2-00 and M2-02 build on it.

## Scope

**Owner actions:** the Claude Console organisation and API key exist (`ANTHROPIC_API_KEY` in `.env`); the owner opens Console > Settings > Limits (and Usage) and saves a screenshot of the organisation's rate-limit tier and the credit balance into `docs/recon/` (gitignored, never committed); a worker records the numbers read from it. Workers draft nothing that needs the key before it exists and comment on the issue if absent.

Script under `scripts/spikes/anthropic/` using `@anthropic-ai/sdk` 1.3.0 and `zod` 4.6.7 (versions from `docs/evidence/toolchain.md`; already pinned by M0-02), reading the key from the environment only and printing no secret. Spend real tokens only to prove an acceptance criterion; iterate on recorded responses.

1. **Structured outputs**: `client.messages.parse` with `output_config.format` built by `zodOutputFormat(schema)` on `claude-haiku-5-5` (extraction) and `claude-sonnet-5-5` (criticality, drafting). Note zod constructs the schema layer rejects (no min/max, `additionalProperties:false`) and the working schema subset.
2. **PDF extraction**: send two or three documents from the M0-08 dataset as PDF input; each extracted fact has `value`, `quote` (verbatim) and `page`. Verify every quote with `unpdf` 2.1.0 text-layer search (normalise whitespace only) and report the verified fraction; test an image-only scan from the dataset and record the behaviour (the product rule is owner confirmation, not guessing).
3. **Cost**: record `usage` input/output tokens per document and per draft, compute dollars at the PROJECT.md §4 prices (Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10 per million tokens; note the 5x rule above 100k prompt tokens) and project the cost of the full demo arc.
4. **stop_reason handling**: provoke and record `max_tokens` (low limit) and a refusal-style case if reproducible; write the handling rule (never use truncated output as valid; refusal becomes NEEDS_OWNER).
5. **Rate limits**: read the `anthropic-ratelimit-*` response headers from a real call, combine with the console tier, and record requests-per-minute and tokens-per-minute available; run a small burst to see 429 and the SDK retry behaviour.
6. **Prompt-injection probe**: send the dataset invoice that hides an instruction; record that the schema-constrained extraction does not follow it (observational input for evals).

Write findings to `docs/evidence/anthropic-spike.md` (tracked; no screenshot, no key, no organisation id). Fixtures: redacted real responses in `fixtures/anthropic/` (strip keys and any organisation/request identifiers beyond `request_id`).

## Out of scope

- The production extraction pipeline, prompts library, eval harness, or caching strategy (M2-00, M2-02, M4)
- Choosing different models or providers; Opus use
- Third-party or cloud-hosted model gateways (first-party API only)
- Spending beyond the per-run cap (set `MODEL_PER_RUN_CAP_USD` for the run and abort when exceeded)

## Acceptance Criteria

- [ ] `messages.parse` + `zodOutputFormat` returns a typed object validated by zod for both models; fixtures recorded
- [ ] Every extracted fact has a quote and page; the share verified against the `unpdf` text layer is reported, and mismatches are shown as such
- [ ] The image-only scan is handled as designed and the observed behaviour recorded
- [ ] Tokens and dollars per document and per draft are in the evidence file, with the demo-arc projection and its comparison to the $100 grant
- [ ] `max_tokens` and refusal handling are demonstrated and the rule written
- [ ] The organisation rate-limit tier and the observed `anthropic-ratelimit-*` header values are recorded; a 429 and the SDK retry behaviour are observed or documented as not reachable
- [ ] The run stayed under `MODEL_PER_RUN_CAP_USD`; total spend recorded
- [ ] No key appears in output, fixtures or evidence (pattern scan passes); the console screenshot is not tracked

## Deliverables

- `scripts/spikes/anthropic/*.mjs` (entry point `run.mjs`; TypeScript allowed only if compiled by the M0-02 toolchain)
- `fixtures/anthropic/*.json`
- `docs/evidence/anthropic-spike.md`

## Validation Gate

```bash
set -euo pipefail
test -n "${ANTHROPIC_API_KEY:-}" || { echo "missing ANTHROPIC_API_KEY (owner step)" >&2; exit 2; }
T="${TMPDIR:-/tmp}/m0-06"; rm -rf "$T"; mkdir -p "$T"
export MODEL_PER_RUN_CAP_USD="${MODEL_PER_RUN_CAP_USD:-2}"
node scripts/spikes/anthropic/run.mjs >"$T/out.txt" 2>&1
! grep -F "$ANTHROPIC_API_KEY" "$T/out.txt"
ls fixtures/anthropic/*.json | wc -l | awk '{ exit ($1 >= 4 ? 0 : 1) }'
node scripts/spikes/anthropic/verify-quotes.mjs fixtures/anthropic >"$T/quotes.txt"; cat "$T/quotes.txt"
for k in 'rate' 'tier' 'stop_reason' 'per document' 'per draft'; do grep -q -i "$k" docs/evidence/anthropic-spike.md || { echo "evidence lacks: $k" >&2; exit 1; }; done
if grep -R -E 'sk-an[t]-[A-Za-z0-9_-]{8,}' fixtures docs scripts "$T"; then echo "key pattern" >&2; exit 1; fi
git check-ignore -q docs/recon/
./scripts/check-no-secrets.sh
```

## Handoff

- M2-00 (model-call layer) needs the zod subset that works, the `messages.parse` call shape, and the stop_reason rule.
- M2-02 (extraction pipeline) needs the quote verification method, the image-only behaviour and cost per document.
- M2-05 (drafting) and M4 (evals) need the cost per draft, the rate-limit tier and the injection finding; the manager uses the per-run figures to set the budgeted resource caps.
- Post on the issue: tier and limits, cost table, verified-quote fraction, and the spend total (no screenshots, no ids).
