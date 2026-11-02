---
title: "M2-05 · Drafting + verifier (citations, numbers/dates/names) + NEEDS_OWNER"
milestone: "M2 · Evidence to Answer"
labels: ["agent"]
blocked_by: ["M2-00", "M2-02", "M2-04"]
estimate: "8h"
resources: ["ANTHROPIC"]
needs: []
---

## Context

This is the product's core claim (R1, R5): the model drafts, code verifies. ADR 0010 says a fluent answer that cites a hallucinated figure is worse than none, so every draft is checked against the facts it cites, and anything that fails becomes `NEEDS_OWNER`. Because Airwallex respond needs **every** question answered (contract file: "answer all questions", partial acceptance UNKNOWN until M0-04), one `NEEDS_OWNER` blocks the whole RFI and the owner is told why. Success metric (a): at least 95% of eval-set questions grounded and 100% of mutated drafts rejected. RFI text and documents are untrusted data (ADR 0009).

Model: `claude-sonnet-5-5` (`ANTHROPIC_MODEL_DRAFT`), about $0.045 per RFI draft (estimate, measured here).

## Scope

1. **Draft call** through the M2-00 harness: input = the RFI's questions (title, description, answer type), the linked payment's usable fact versions (value, quote, page, fact_version_id, document id), and prior approved answers surfaced by M2-06 when present (reuse proposals are passed as optional data; this ticket works without them). All inputs wrapped as untrusted data; injection flags from `scanInjection` stored on the draft. One call per RFI round covering all questions (within the 2-calls-per-question limit); output schema per question `{question_id, status: "answered" | "cannot_answer", text, citations: [{fact_version_id, quote}]}`. For `ATTACHMENT` questions the output selects `document_ids` from the supplied list only; the model produces no file.
2. **Verifier (pure code)** per answered question:
   - every citation's `fact_version_id` exists in the supplied set and its quote equals the stored quote (no model-supplied text trusted)
   - every number, date and name token in `text` appears in the cited facts (amounts compared by parsed minor-unit value and currency, dates by ISO value across formats, names by the same normalisation as M2-03); numbers/dates/names not supported fail
   - the text contains no URL, no instruction-like content and no tokens outside an allowlist of connective words, or it fails closed
   - for `ATTACHMENT`: each document id exists, belongs to the business and has a verified or confirmed fact set
   - a question with a `cannot_answer`, an empty citation list for a factual claim, an unsupported `answer_type` (IDENTITY_DOCUMENT, LIVENESS, ADDRESS, CONFIRMATION that Carnet does not handle), or any verifier failure becomes `NEEDS_OWNER` with a machine reason code and a plain-language explanation.
3. **RFI-level rule**: any question `NEEDS_OWNER` sets the RFI state `NEEDS_OWNER` (all-or-nothing, with the list of blocking questions and reasons stored); all verified sets `DRAFT_READY`. Transitions go through the M2-04 state machine and are audited.
4. **Degradation**: harness outcomes `disabled`, `cap_exceeded`, `limit_exceeded`, `refused`, `truncated`, `provider_error` all produce `NEEDS_OWNER` with reason `MODEL_UNAVAILABLE` (or the matching code) so the owner can write the answers; the RFI is never stuck in DRAFTING (a timeout sweeper moves it after the run limit).
5. **Draft immutability**: `drafts` / `draft_answers` per architecture §5 (draft: rfi_id, round, prompt_version, model, input_hash, injection_flags; answer: question_id, text, citations, verifier_result, status). No update path; an owner edit or a re-draft inserts a **new draft** (new id) whose owner-written text goes through the same verifier, and the previous draft stays. Owner-written text that cites facts is verified the same way; text without citations is allowed only as an explicit `owner_authored` answer that the UI shows as unverified.
6. **Job**: handler for `rfi.draft` (from M2-04) with run kind `rfi_draft`, correlation ids, event `draft.ready` published in the same transaction as the draft.
7. **Tests and eval data**: unit tests on recorded fixtures (`fixtures/anthropic/`) and a **mutation set**: take the good drafts for the dataset RFI question sets (M0-08), inject wrong amounts, wrong currencies, shifted dates, swapped or altered names, an invented fact, a citation to a fact id from another business, a changed quote, a URL and an instruction string; generate at least 200 mutants. The verifier must reject **100%** and accept 100% of the unmutated grounded drafts in the set. The numbers are written to `docs/evidence/verifier-eval.md`.
8. **Live proof**: one live drafting run over the dataset RFI sets within `MODEL_PER_RUN_CAP_USD`, responses recorded to `fixtures/anthropic/drafting/`, with the share of questions grounded without owner help reported (target at least 95% on the dataset's answerable questions; unanswerable ones must come back NEEDS_OWNER).

## Out of scope

- Answer memory lookup (M2-06) beyond accepting its output as optional input
- Approval, respond, UI (M2-07, M2-08)
- Criticality (M3-01); any tool use by the model

## Acceptance Criteria

- [ ] On recorded fixtures every answerable dataset question yields a draft whose citations all resolve and whose numbers, dates and names all appear in cited facts; the RFI becomes `DRAFT_READY`
- [ ] Mutation set: at least 200 mutants, **100% rejected** (reported per mutation class); unmutated grounded drafts accepted 100%
- [ ] A question with no supporting document yields `NEEDS_OWNER` with a reason; the RFI becomes `NEEDS_OWNER` and lists the blocking questions
- [ ] With `agents_enabled=false`, with cap exceeded, and with a recorded provider error, the RFI goes to `NEEDS_OWNER` (`MODEL_UNAVAILABLE`) and not left in DRAFTING
- [ ] A document or RFI question containing an injection string (dataset injection case) does not change the output; flags are stored; any resulting unsupported claim is rejected by the verifier
- [ ] Editing a draft creates a new draft id; the original rows are unchanged and the DB role cannot update `draft_answers.text`
- [ ] Owner-authored text citing a wrong figure is rejected by the same verifier
- [ ] No request built by the draft call contains `tools` or any secret; the model is called at most twice per question (test)
- [ ] Live run: grounded rate and cost posted; recorded under `fixtures/anthropic/drafting/`; run within the per-run cap
- [ ] Event-to-draft time on a replayed run is below 60 s p95 locally (timestamps from `agent_steps`)

## Deliverables

- `packages/agent/src/drafting/` (`draft.ts`, `prompts/draft.ts`, `handler.ts`), `packages/domain/src/rfi/verifier.ts` (pure) and tests
- `packages/db/src/schema/drafts.ts`, migration, repository
- `packages/agent/evals/verifier-mutation/` and `docs/evidence/verifier-eval.md`
- `fixtures/anthropic/drafting/`

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; T="$(mktemp -d "$TMPDIR/m2-05.XXXXXX")"
npm run typecheck
npm run test -w packages/domain -- verifier
npm run test -w packages/agent -- drafting
npm run test -w packages/db -- drafts
npm run eval -w packages/agent -- verifier-mutation --out "$T/mutation.json"
jq -e '.mutants >= 200 and .rejected == .mutants and .good_accepted == .good_total' "$T/mutation.json"
npm run eval -w packages/agent -- drafting --replay --out "$T/drafting.json"
jq -e '.grounded_rate >= 0.95 and .unanswerable_to_needs_owner == 1' "$T/drafting.json"
./scripts/check-no-secrets.sh
# live proof once, by the worker: npm run eval -w packages/agent -- drafting --live
```

## Handoff → M2-06, M2-07, M2-08

M2-06 stores approved answers with their citations; M2-07 binds draft id, answer texts, prompt version and fact version ids shown; M2-08 renders drafts, citations, source snippets and NEEDS_OWNER reasons. Post an issue comment with the reason codes, schema of `draft_answers`, mutation numbers and the live-run cost and grounded rate.
