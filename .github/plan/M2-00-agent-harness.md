---
title: "M2-00 · Agent harness"
milestone: "M2 · Evidence to Answer"
labels: ["agent"]
blocked_by: ["M1-02"]
estimate: "6h"
resources: []
needs: []
---

## Context

Carnet's three model calls (extract, propose criticality, draft) are the only place a model touches the product, and ADR 0009 says they are pure functions from data to schema-validated JSON with no tools and no credentials. R5 ("code enforces, model judges") and the risk "Anthropic rate limits / credits drained" (PROJECT.md §10) are decided here: every later agent ticket (M2-02, M2-05, M3-01, M4-02, M4-03) calls the model only through this harness. It is the one place that enforces spend caps, the kill switch, call limits, replay of stored output, prompt versioning and the untrusted-input guardrail (architecture §10).

The harness is proven on **recorded fixtures** (`fixtures/anthropic/` from M0-06); no real tokens are needed.

## Scope

In `packages/agent` (and the tables in `packages/db`):

1. **Tables and repository** (`agent_runs`, `agent_steps` per architecture §5): run = id, business_id, kind, ref, status, tokens, cost, started/finished; step = id, run_id, step, prompt_version, model, input_hash, output, latency_ms, stop_reason. Drizzle migration, repository scoped by `business_id`, indexes for `(run_id, step)` and `(kind, ref)`.
2. **Structured-output wrapper** over `@anthropic-ai/sdk` 1.3.0: `callStructured({run, step, promptVersion, model, system, blocks, schema})` using `messages.parse` with `zodOutputFormat`. It checks `stop_reason` (`refusal` and `max_tokens` are typed failures, never partial output), validates the parsed output with the zod schema again in code, applies the SDK timeout (60 s) and jittered retry honouring `retry-after`, and records tokens and cost from the usage block.
3. **Spend caps**: per-run and daily caps read from `system_flags` (seeded from `MODEL_PER_RUN_CAP_USD` and `MODEL_DAILY_SPEND_CAP_USD`). The harness estimates the worst-case cost of a call before sending (input tokens plus `max_tokens` at the model's price) and refuses when the run or the day would exceed its cap; actual cost is added after the call.
4. **Kill switch**: `agents_enabled` in `system_flags` is read **before every model call**; when false the call returns a typed `AGENTS_DISABLED` result without touching the network.
5. **Call limits**: at most **2 model calls per question** (per `run.ref` + question key), a per-call `max_tokens`, a per-call wall-clock limit and a per-run wall-clock limit; exceeding any is a typed `LIMIT_EXCEEDED` result.
6. **Stored-output replay**: before calling, look up a finished step with the same `(run kind, ref, step, input_hash, prompt_version)`; if found return the stored output with `replayed: true` and make no network call. A run that crashed after the model replied but before the caller used the result therefore replays, never re-spends.
7. **Prompt versioning**: each prompt is a module exporting its text; `promptVersion` is the SHA-256 (first 12 hex) of the exact system text plus the schema's JSON schema. A change in either changes the version; steps record it.
8. **Input guardrail scaffold**: `wrapUntrusted(label, text)` puts documents, RFI text and prior answers in delimited blocks (delimiter chosen so it cannot occur in the content; content containing it is escaped), and the system prompt states that block content is data. `scanInjection(text)` returns flags (instruction-like phrases, role-change markers, delimiter forgery, hidden-text hints) that callers store for owner review; a flag never blocks by itself and never changes behaviour of the model call.
9. **No tools, no credentials**: the wrapper passes no `tools`, never puts a secret in a prompt, and the API key is read in one module only. A test asserts the request body has no `tools` field.
10. **Degradation result type**: every outcome is a discriminated union (`ok | replayed | refused | truncated | disabled | cap_exceeded | limit_exceeded | provider_error`) so callers can map any non-ok outcome to `NEEDS_OWNER` or "owner must confirm".

## Out of scope

- The extraction, criticality and drafting prompts themselves (M2-02, M3-01, M2-05)
- The kill-switch UI and DB circuit breakers (M4-02), the eval suite (M4-03)
- Any call to the real API in the tests of this ticket

## Acceptance Criteria

- [ ] Migration creates `agent_runs` and `agent_steps`; repository tests prove cross-tenant reads return nothing
- [ ] On a recorded fixture the wrapper returns a zod-validated object and writes one step with prompt version, input hash, tokens, cost and `stop_reason`
- [ ] A recorded `stop_reason: refusal` and a recorded `max_tokens` response each yield a typed failure and never a parsed object
- [ ] With `agents_enabled=false` no HTTP request is made (transport spy sees zero calls) for 100 calls
- [ ] A call whose worst-case cost would exceed the per-run cap, and one that would exceed the remaining daily cap, are refused before the network; the counters are unchanged after refusal
- [ ] A third model call for the same question key returns `limit_exceeded`; a call over the token or time limit does too
- [ ] Crash replay: simulate a process that stored the step and died; a new run with identical inputs returns the stored output, `replayed: true`, zero network calls and zero added cost
- [ ] Changing one character of a system prompt or the schema changes `promptVersion`; the same inputs keep the same version
- [ ] Injection pre-scan flags every payload in a fixture set of at least 15 injection strings (including delimiter forgery) and none of at least 15 benign invoice or RFI texts
- [ ] A test asserts no `tools` key and no env secret value appears in any request body built by the harness
- [ ] `packages/agent` imports no web framework and the domain package imports nothing from it

## Deliverables

- `packages/agent/src/` (`harness.ts`, `structured.ts`, `caps.ts`, `replay.ts`, `guardrail.ts`, `prompt-version.ts`, `index.ts`) and tests
- `packages/db/src/schema/agent.ts`, migration, `packages/db/src/repos/agent-runs.ts`
- Recorded-response loader for tests reading `fixtures/anthropic/`
- `docs/agent-harness.md` (short: outcomes, limits, how to add a call)

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; T="$(mktemp -d "$TMPDIR/m2-00.XXXXXX")"
npm run typecheck -w packages/agent
npm run test -w packages/agent -- --reporter=json --outputFile="$T/agent.json"
test "$(jq '[.testResults[].assertionResults[] | select(.status=="failed")] | length' "$T/agent.json")" = 0
npm run test -w packages/db -- agent-runs
# no network in these tests
grep -rn "api.anthropic.com" packages/agent/src && exit 1 || true
grep -rnE "tools\s*:" packages/agent/src && exit 1 || true
./scripts/check-no-secrets.sh
```

## Handoff → M2-02, M2-05 (and later M3-01, M4-02, M4-03)

They call `callStructured`, pick a `promptVersion` via `prompt-version.ts`, wrap untrusted inputs with `wrapUntrusted` and store `scanInjection` flags, and map every non-`ok` outcome to their own degradation. Post an issue comment with the outcome union, the exported function signatures, the `system_flags` keys used and the fixture loader path.
