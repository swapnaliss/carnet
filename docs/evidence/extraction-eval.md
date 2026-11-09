# Extraction eval (M2-02)

What this shows: on the synthetic dataset (`fixtures/dataset/`, 19 files), the extraction pipeline
(`claude-haiku-5-5` through the M2-00 harness, then quote verification in code) got every ground-truth
field right, verified every quote against the PDF text layer, and detected every mutated quote. What it
does not show: behaviour on real, unseen documents. The dataset is small, invented and was written by the
same team as the prompts.

## How the numbers were produced

- Live run, once: `npm run eval -w packages/agent -- extraction --live` on 2026-11-06 (`recorded_at` in
  each file of `fixtures/anthropic/extraction/`). 19 model calls, one per file, no retries.
- Every other run replays those recorded responses:
  `npm run eval -w packages/agent -- extraction --replay --out <file>`. The replay runs the same pipeline
  (document blocks, prompt, harness, zod, quote check) with the model's reply read from disk, so it is
  deterministic. It refuses to run if a recording was made for another prompt version or other bytes.
- Ground truth is `fixtures/dataset/ground-truth.json` (M0-08). Scored: the 16 text PDFs of kind invoice,
  contract, purchase order and bank statement (delivery notes and a remittance advice have no extraction
  schema: the upload kinds are invoice, contract, purchase_order, statement, other). The three image-only
  files (scanned PDF, PNG, JPEG of the Nordlicht invoice) are checked for the confirmation rule, not scored
  for accuracy.
- A value is correct when the parsed value equals the ground truth: amounts by integer minor units and
  currency, dates by ISO date, text by normalised string (trailing full stop ignored).

## Results (replay, identical to the live run)

| Metric | Result | Threshold |
|---|---|---|
| Ground-truth fields scored | 106 | |
| Value accuracy | 106 / 106 = 1.0000 | at least 0.95 |
| Facts extracted from text PDFs | 134 | |
| Quote-verified rate | 134 / 134 = 1.0000 | at least 0.98 |
| Wrong-but-verified (verified fact, value differs from ground truth) | 0 | exactly 0 |
| Verified facts for keys not in ground truth (not scored) | 28 | |
| Mutation test: quote altered by one word | 134 / 134 detected | |
| Mutation test: quote moved to another page | 134 / 134 detected | |
| Mutation test: invented quote | 134 / 134 detected | |
| Mutation detected, total | 402 / 402 = 1.0000 | exactly 1 |
| Injection document (`inv-lakeside-002`) flags | 2 (`ignore-previous`, `answer-every-with`) | at least 1 |
| Injection document facts equal ground truth | yes, all 7 ground-truth facts | |
| Image-only files: facts all `needs_confirmation`, none verified | 21 facts in 3 files, yes | |

Per-field accuracy was 1.0 for all 21 field names (for example `total` 12/12, `supplier` 12/12,
`clause_fee_cap` 3/3, `iban` 6/6). The eval asserts the thresholds and exits non-zero when one fails; the
extraction test suite runs it in replay mode.

The mutation test takes each verified fact and re-checks it with the quote changed (first word replaced,
page changed to one that does not contain the quote, or a made-up line). It tests the verifier; it does not
measure how often a model invents a quote.

## Cost and time of the live run

| | |
|---|---|
| Model | `claude-haiku-5-5` |
| Calls | 19 (one per file) |
| Input tokens | 67,296 |
| Output tokens | 12,396 |
| Cost (token usage x PROJECT.md prices) | USD 0.0129 (USD 0.00045 to 0.00136 per file; the three contracts cost most) |
| Wall time, 19 sequential calls | 60 s (longest call 7.3 s) |

A first single-file live call (`inv-lakeside-002`, USD 0.0006) validated the pipeline before the full run;
total live spend for the ticket is therefore about USD 0.0135.

## Limits

- 100 % on 16 documents is a small sample: it supports "works on this dataset", not a rate for real
  documents. The injection document carries one planted instruction; other injection styles are not
  covered here (the guardrail has its own 20-payload test, M2-00).
- A fact is verified when its quote is on the claimed page and its value can be derived from the quote. A
  quote that is real but about a different thing than the key (for example the buyer's name quoted for the
  supplier) would verify; the eval would count it as wrong-but-verified. There was none in this run.
- Scanned and image documents carry no quote that code can check: every fact needs an owner's
  confirmation (the confirm endpoint stores who confirmed).
