---
title: "M2-02 · Extraction pipeline (Haiku, quote + page verified against the PDF text layer via unpdf, image-only → owner confirm)"
milestone: "M2 · Evidence to Answer"
labels: ["agent"]
blocked_by: ["M2-00", "M2-01", "M0-08"]
estimate: "8h"
resources: ["ANTHROPIC"]
needs: ["P-04"]
---

## Context

Everything downstream (evidence flags, drafts, answer memory) trusts facts extracted from documents. A wrong extracted fact would pass any verifier that only checks drafts against facts, so ADR 0010 makes extraction itself grounded: each fact carries a verbatim quote and a page, and **code** checks the quote against the PDF text layer. This is R5 (code enforces, model judges) and the first half of the grounding claim in the success metric (95% grounded, 100% mutations rejected). Documents are untrusted data (ADR 0009); a document that tells the model to ignore its instructions must be treated as data and flagged.

Model: `claude-haiku-5-5` (`ANTHROPIC_MODEL_EXTRACT`), about $0.004 per document (architecture §1, an estimate to be measured here).

## Scope

1. **Per-type schemas** (zod 4, in `packages/domain` so the shape is shared): `invoice` (invoice number, supplier name, buyer name, issue date, due date, currency, total amount, line-item total, bank reference), `contract` (parties, effective date, term/end date, payment terms, governing law, amount/rate clauses, signatories), `purchase_order` (PO number, buyer, supplier, date, currency, total), `statement` (account holder, period start/end, opening and closing balance, currency, credit lines). Every fact is `{key, value, quote, page}`; amounts are parsed to integer minor units plus ISO currency in code, dates to ISO dates, never by the model.
2. **Extraction call** through the M2-00 harness (`callStructured`): a prompt per document type with a version hash; PDFs go in as document blocks, images as image blocks, wrapped as untrusted data; structured output; at most one call per document (one retry only for a typed `max_tokens`/schema failure, within the harness's 2-call limit).
3. **Quote verification in code** with `unpdf` 2.1.0: extract the text layer per page, normalise whitespace, hyphenation and Unicode form, and require that `quote` occurs verbatim (after normalisation) on the claimed `page`. A fact whose quote is not found is marked `quote_verified=false` and may not be used as evidence. The normalisation function is pure and unit-tested; the value must also appear within or be derivable from the quote (amount and date matching by parsed value, not substring).
4. **Image-only documents** (JPEG, PNG, or a PDF with no usable text layer): extraction still runs, but every fact is `needs_confirmation`; no fact is usable until an authorised owner confirms it through an endpoint (`POST /api/v1/documents/{id}/facts/{version}/confirm` with the confirming user recorded in `owner_confirmed_by`). Confirmation can include correcting a value, which creates a new version.
5. **`document_facts` versioned and immutable**: id, document_id, version, prompt_version, model, facts, quotes (text + page), quotes_verified, owner_confirmed_by, injection_flags, created_at. A re-extraction or a correction inserts version n+1; no update or delete path exists.
6. **Injection handling**: documents are wrapped with `wrapUntrusted`; `scanInjection` flags are stored on the version and shown for owner review; the output schema leaves no field in which an instruction could act, and a flagged document's facts are still verified like any other (the instruction is data, not an action).
7. **Job wiring**: an outbox job `document.extract` is enqueued when a document is stored (ADR 0005); the worker runs it; failures map to a typed `EXTRACTION_FAILED` state shown to the owner (never silently empty facts); the event `document.extracted` is published in the same transaction as the facts.
8. **Evals** (`packages/agent/evals/extraction`): run the pipeline over `fixtures/dataset/` documents with ground truth (M0-08) and report per-field accuracy, quote-verification rate, rate of wrong-but-verified values, and flags raised on the injection document. The eval runs on recorded responses (`fixtures/anthropic/`) by default; a `--live` mode spends real tokens.
9. **Live proof**: one live run over the dataset set (cost recorded in the issue comment, within `MODEL_PER_RUN_CAP_USD`), recorded into `fixtures/anthropic/extraction/` for replay.

## Out of scope

- Criticality proposals from contracts (M3-01), evidence rules (M2-03), drafting (M2-05)
- OCR of image-only documents (they require owner confirmation instead)
- Calling any URL or tool from a document

## Acceptance Criteria

- [ ] Replaying recorded responses for every dataset document type produces schema-valid facts with parsed minor-unit amounts and ISO dates
- [ ] Quote verification: every fact on the dataset's text PDFs has `quote_verified=true`; a fixture where the model's quote is altered by one word, by a different page, or invented is marked `quote_verified=false` (mutation test, 100% detected)
- [ ] An image-only fixture (PNG and a scanned-style PDF) yields facts that are all `needs_confirmation`; the evidence-usable view returns none of them until `confirm` is called by an authorised user, and the confirming user is stored
- [ ] A confirm or correction creates version n+1; attempts to update or delete an existing version fail at the repository and as the app DB role
- [ ] The injection document in the dataset is processed: its text is delimited, its flag list is non-empty on the stored version, no instruction in it changes the output shape, and the facts match ground truth
- [ ] Eval report on the dataset states per-field accuracy, quote-verified rate and wrong-but-verified count; **wrong-but-verified is 0** on the fixtures; thresholds (value accuracy at least 95%, quote-verified at least 98% on text PDFs) are asserted by the eval and fail the run otherwise
- [ ] With `agents_enabled=false` extraction produces `EXTRACTION_FAILED` (not empty facts) and the document stays usable for manual confirmation entry
- [ ] A crash between the model reply and the facts write replays stored output (no second model call, per M2-00)
- [ ] One live run over the dataset completes within the per-run cap; its cost, token counts and wall time are posted, and its responses are saved under `fixtures/anthropic/extraction/`
- [ ] Cross-tenant read of facts returns nothing

## Deliverables

- `packages/domain/src/evidence/fact-schemas.ts`, `packages/domain/src/evidence/quote-match.ts`
- `packages/agent/src/extraction/` (`extract.ts`, `prompts/<type>.ts`, `verify-quotes.ts`, `worker-handler.ts`), `packages/agent/evals/extraction/`
- `packages/db/src/schema/document-facts.ts`, migration, repository
- `apps/web/src/app/api/v1/documents/[id]/facts/...` routes (list, confirm)
- `fixtures/anthropic/extraction/` (recorded real responses), `docs/evidence/extraction-eval.md` (numbers from the eval, tracked)

## Validation Gate

```bash
set -euo pipefail
export TMPDIR="${TMPDIR:-/tmp}"; T="$(mktemp -d "$TMPDIR/m2-02.XXXXXX")"
npm run typecheck
npm run test -w packages/domain -- evidence
npm run test -w packages/agent -- extraction
npm run eval -w packages/agent -- extraction --replay --out "$T/extraction-eval.json"
jq -e '.wrong_but_verified == 0 and .value_accuracy >= 0.95 and .quote_verified_rate >= 0.98 and .mutation_detected == 1' "$T/extraction-eval.json"
jq -e '.injection_document.flags | length > 0' "$T/extraction-eval.json"
npm run test -w packages/db -- document-facts
./scripts/check-no-secrets.sh
# live proof is run once by the worker (claims ANTHROPIC); its cost is posted on the issue:
#   npm run eval -w packages/agent -- extraction --live
```

## Handoff → M2-03, M2-05, M3-01

M2-03 consumes `document_facts` (verified or confirmed only) for the evidence rules; M2-05 cites fact version ids and quotes; M3-01 reuses the contract schema and the harness. Post an issue comment with the fact keys per type, the repository function that returns only usable facts, the eval numbers and the live-run cost.
