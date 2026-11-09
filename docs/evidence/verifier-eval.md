# Draft verifier and drafting eval (M2-05)

What this shows, and what it does not. Commands and numbers are from the run that produced the recordings in
`fixtures/anthropic/drafting/`; rerun them with `npm run eval -w packages/agent -- verifier-mutation` and
`npm run eval -w packages/agent -- drafting --replay`.

## The verifier (`packages/domain/src/rfi/verifier.ts`, pure code)

A draft answer is accepted only if all of these hold, checked against the facts the draft call was given
(verified or owner-confirmed facts of the business), never against anything the model supplied:

- every citation names a supplied fact and repeats its stored quote (after the same text normalisation as
  M2-02);
- every amount (compared as minor units and currency), date (compared as an ISO date, whatever the written
  format), number, reference and name in the text occurs in the cited facts; a run of two or more capitalised
  words must occur as a phrase in one cited fact;
- every other word is a connective or generic payment word from a fixed allowlist (`ALLOWED_WORDS`), or it
  appears in a cited fact; anything else fails closed;
- no URL, e-mail address or instruction-like phrase; at most 1,500 characters;
- cited facts do not contradict each other, and no cited fact comes from a document that disagrees with
  another document about the same purchase order (invoice total against purchase order total);
- an ATTACHMENT answer selects documents of the business that have usable facts, or whose kind has no
  extraction schema (a delivery note or remittance advice: there is nothing to verify, the owner approves the
  exact file);
- question types Carnet does not handle (identity document, liveness, address, confirmation) are never
  answered.

Anything else is `NEEDS_OWNER` with a reason code and a plain-language explanation; one `NEEDS_OWNER`
question makes the whole RFI `NEEDS_OWNER` (Airwallex respond needs every question answered).

## Mutation eval (`packages/agent/evals/verifier-mutation/`)

Good drafts: the 16 answers the model gave for the answerable dataset questions in the recorded run, plus 12
hand-written grounded drafts (`good-drafts.ts`) that check the verifier is not too strict. Each good draft is
made wrong in named ways (`mutate.ts`).

| Result | Value |
|---|---|
| Mutants | 651 |
| Rejected | 651 (100%) |
| Good drafts accepted | 28 of 28 (recorded 16 of 16, hand-written 12 of 12) |

Per class (mutants, all rejected, with the reason code the verifier gave):

| Class | Mutants | Rejected for |
|---|---|---|
| wrong amount (+1 unit, x10, +1 cent) | 27 | UNSUPPORTED_AMOUNT |
| wrong currency | 9 | UNSUPPORTED_AMOUNT |
| shifted date (+1 day, +30 days, -1 year) | 24 | UNSUPPORTED_DATE |
| wrong reference (last digit) | 19 | UNSUPPORTED_NUMBER |
| altered name (letter dropped or replaced) | 92 | UNSUPPORTED_NAME |
| swapped name (another dataset party) | 46 | UNSUPPORTED_NAME |
| invented fact (new party, place, figure and date, relation) | 68 | UNSUPPORTED_TOKEN 51, UNSUPPORTED_AMOUNT 17 |
| citation to a fact id not in the supplied set (another business) | 32 | CITATION_UNKNOWN_FACT |
| changed quote (a word, a digit) | 58 | QUOTE_MISMATCH |
| URL, domain, e-mail appended | 51 | URL_PRESENT |
| instruction string appended | 51 | INSTRUCTION_LIKE |
| citations dropped | 17 | NO_CITATIONS |
| attachment (unknown id, none, unverified document, text without citations) | 45 | ATTACHMENT_*, NO_CITATIONS |
| unsupported answer type | 112 | UNSUPPORTED_ANSWER_TYPE |

Every class was rejected for the reason it is meant to trigger.

**Not covered, by design of the check.** The verifier proves that what an answer says is *in the cited
documents*, not that it is the *right* statement. A mutant that swaps two values that are both cited (for
example the invoice date for the due date, or buyer for supplier) uses only supported words and would be
accepted. The owner's review of the cited snippets beside each claim is the control for that. The mutants
above are also written by the builder, so they show the classes named, not every way a draft can be wrong.

## Drafting eval on the dataset (live run, recorded)

Seven drafting cases from the six dataset RFI sets (round 2 of the follow-up set drafts only its new
question; the repeated one is answer reuse, M2-06). Facts come from the M2-02 extraction recordings through
the real extraction pipeline. Model `claude-sonnet-5-5`, prompt version `8f4f58a2a12c`.

| Metric | Value |
|---|---|
| Answerable questions grounded (VERIFIED) | 16 of 16 (target at least 95%) |
| Attachment questions that selected the expected document | 8 of 8 |
| Text answers that cite the expected document | 8 of 8 |
| Unanswerable questions returned as NEEDS_OWNER | 9 of 9 (invoice scan, contract-less, contradicting totals, no delivery note, new follow-up question) |
| Unanswerable questions answered anyway | 0 |
| Injected claim in any answer (dataset injection set) | 0 |
| Cost of the final recorded run | USD 0.116506 for 7 calls (24,373 input and 6,776 output tokens), about USD 0.017 per RFI round |
| Longest single draft call | 9.9 s |
| Event to draft, replayed (20 RFIs, outbox job to recorded agent step, local Postgres) | p95 65 ms, max 74 ms (the model call is replayed; a live call took up to 9.9 s) |

**How to read these numbers.** The sample is small (16 answerable, 9 unanswerable questions, one synthetic
business) and they are not a measure on unseen documents. The prompt and the allowlist were tuned on these
same sets: the first full live run grounded 13 of 16 and answered 2 unanswerable questions, the second 11 of
16, the third (the recorded one) 16 of 16. The changes were: the document list now shows each file name and
whether its facts are unverified; two rules in the prompt (choose a document of kind `other` by its name, do
not answer from other documents what an unreadable document would answer); a document-level conflict rule in
the verifier; and a few generic words added to the allowlist (`between`, `parties`, `scope`, ...). Model output is not
deterministic; a fresh run may differ. The dataset injection set raised no injection flag at drafting
because M2-02 already kept the hidden instruction out of the facts; the injection tests with a model that
obeys the instruction are in `packages/agent/test/drafting/drafting.test.ts`.

Total Anthropic spend for this ticket: USD 0.349128 (four live runs of the drafting eval while tuning; the
provider-error fixture is a real 401 response to a request with a deliberately invalid key and cost nothing).
