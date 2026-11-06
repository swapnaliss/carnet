# Agent harness (M2-00)

Every model call in Carnet goes through `createHarness(...).callStructured` in `packages/agent`
([ADR 0009](adr/0009-deterministic-workflow-no-money-tools.md), architecture §10). The model gets data
and a schema. It gets no tools, no credentials and no write access.

## Outcomes

`callStructured` never throws for a model or provider problem. It returns a `CallOutcome<T>`, a union
on `outcome`:

| outcome | when | network | step written |
|---|---|---|---|
| `ok` | `stop_reason: end_turn` and the output passes the zod schema again in code | yes | yes (`ok`, output stored) |
| `replayed` | a stored `ok` step has the same run kind, ref, step, input hash and prompt version | no | no (no cost) |
| `refused` | `stop_reason: refusal`, even if the text parses | yes | yes |
| `truncated` | `stop_reason: max_tokens`, even if the text parses | yes | yes |
| `disabled` (`AGENTS_DISABLED`) | `system_flags.agents_enabled` is false, or the flags row can't be read | no | no |
| `cap_exceeded` (`CAP_EXCEEDED`) | worst-case cost would pass the per-run or the daily cap (`cap: per_run \| daily`) | no | no |
| `limit_exceeded` (`LIMIT_EXCEEDED`) | `limit: calls_per_question \| max_tokens \| run_time` (before the network) or `call_time` (the call was aborted) | `call_time` only | `call_time` only |
| `provider_error` | `reason: invalid_output \| unexpected_stop_reason \| http \| timeout \| network \| missing_credential` | yes, except `missing_credential` | yes, except `missing_credential` |

Only `ok` and `replayed` carry `output`. Callers map every other outcome to their own degradation:
`NEEDS_OWNER` for a question, or "owner must confirm" for a fact. They never retry outside the
harness, because the call limit is what bounds spend. The one programming error that throws is
`PromptVersionMismatchError`, raised when the `promptVersion` passed does not match the system text
and schema.

## Checks, in order

1. `maxTokens` above `limits.maxTokensPerCall` gives `limit_exceeded` (`max_tokens`).
2. The kill switch is read fresh from `system_flags` before every call.
3. Replay lookup. A crashed run replays and doesn't spend twice. Replay is served even after the
   question's two calls are used up.
4. At most `maxCallsPerQuestion` (2) network calls per (business, run kind, ref, step). Steps from
   every run count, and failed calls count too. The run's wall clock (`runTimeLimitMs`) is checked
   from `startRun`.
5. Spend caps. The worst case is the UTF-8 byte length of the system text, the blocks and the output
   schema, priced as prompt tokens, plus `maxTokens` of output. The model's price applies, ×5 above
   100k prompt tokens. The call is refused if `run spent + worst case > per-run cap`, or if `spent
   today (UTC, all businesses) + worst case > daily cap`. A refusal writes nothing. After the call, the
   actual cost from the usage block is added.
6. One `messages.parse` call with `zodOutputFormat`, `maxRetries: 2`, a 60 s SDK timeout and an
   `AbortSignal` for the per-call wall clock (`callTimeLimitMs`, retries included). The SDK retries
   408, 409, 429 and 5xx with jittered exponential backoff and honours `retry-after`.

Defaults (`DEFAULT_LIMITS`): 2 calls per question, `max_tokens` ≤ 4096, 90 s per call, 15 min per
run. Override per harness with `limits`.

## Money units

Model cost is an integer in **nano-USD** (`$0.10` per million tokens is 100 nano-USD per token):
`agent_steps.cost_nano_usd` and `agent_runs.cost_nano_usd`. A call costs a fraction of a cent, so
minor units would round it to zero. The caps stay in `system_flags` as USD minor units
(`per_run_cap_minor`, `daily_spend_cap_minor`; seeded at 100 and 1000, which match
`MODEL_PER_RUN_CAP_USD=1` and `MODEL_DAILY_SPEND_CAP_USD=10`). `capToNanoUsd` converts them. A cap in
any other currency allows nothing.

## How to add a model call

1. Write a prompt module that exports the system text, a zod schema and
   `export const VERSION = promptVersion(SYSTEM, Schema)`. Use the schema subset that works
   (`docs/evidence/anthropic-spike.md`). Don't use `z.record`: use an array of `{key, value}`.
   `min`, `max`, length and `regex` are checked by zod after the response, not by the decoder.
2. Put every document, RFI text or prior answer in a block, either `wrapUntrusted(label, text)` as a
   text block or a PDF `document` block. Run `scanInjection(text)` on the same text and store the
   flags for owner review. A flag never blocks the call or changes what is sent.
3. Wire the harness once per business:
   `createHarness({ store: agentHarnessStore(repoCtx(db, businessId)) })` (`@carnet/db`). Then:
   ```ts
   const run = await harness.startRun({ kind: "draft", ref: rfiId });
   const out = await harness.callStructured({ run, step: questionId, promptVersion: VERSION,
     model: "claude-sonnet-5-5", system: SYSTEM, blocks, schema: Schema, maxTokens: 1500 });
   if (out.outcome === "ok" || out.outcome === "replayed") use(out.output); else needsOwner(out);
   await harness.finishRun(run, "DONE");
   ```
4. Test it on recorded responses. `packages/agent/test/recorded.ts` loads `fixtures/anthropic/*.json`
   and replays them through the SDK transport (`recordingTransport`), and it captures every request
   body.

## Tables

- `agent_runs`: id, business_id, kind, ref, status (`RUNNING | DONE | FAILED`), input_tokens,
  output_tokens, cost_nano_usd, started_at, finished_at. Index `(kind, ref)`.
- `agent_steps`: id, business_id, run_id, step, prompt_version, model, input_hash, outcome, output,
  stop_reason, input_tokens, output_tokens, cost_nano_usd, latency_ms, provider_request_id,
  created_at. Index `(run_id, step)`. The composite key `(run_id, business_id)` keeps a step in its
  run's business.

## Known limits

- **Not recorded from a real run:** `stop_reason: refusal` and a 429. M0-06 could not reproduce
  either against the real API (BL-01). The tests build those responses in the recorded shape, and
  `constructedResponse` in `test/recorded.ts` marks them as constructed. `max_tokens` is recorded
  (`stop-max-tokens.json`).
- **Two calls in parallel can both pass the cap check.** There is no reservation; the worst case of a
  single call is the overshoot. Circuit breakers are M4-02.
- **Worst-case input is a byte count.** For a scanned PDF (base64), that is far above the real token
  count, so a large scan on the large model can be refused by the per-run cap. That is deliberate.
- **Spend from an aborted call is unknown.** A `call_time` abort records a step with zero cost,
  because the provider may still have billed it.
