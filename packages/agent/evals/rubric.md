# Draft wording rubric (LLM-as-judge, M4-03)

Rubric version: `rubric@1`. The suite records the SHA-256 of this file in `docs/evidence/evals.md`.

## What the judge scores, and what it never scores

The judge scores only what code cannot check: whether an answer that the verifier already
accepted (VERIFIED) reads well to a compliance reviewer. It never decides whether an answer is
true, grounded or complete. Those are code assertions (the verifier in `packages/domain/src/rfi/verifier.ts`,
the suite's graders), they run first, and a failed code assertion fails the case whatever the judge says
(`combineVerdict` in `packages/agent/evals/suite/judge.ts`).

The judge sees the question title and description and the answer text. It does not see the ground
truth, the expected documents, the facts or the verifier's verdict, so nothing it learns can leak into
the product. It is never called by the product.

## Criteria (each scored 1 to 5)

### 1. Fluency

- 5: clear, grammatical, plain business English; reads as written by a careful finance person.
- 4: clear, with at most one awkward phrase.
- 3: understandable, but stilted or list-like in a way a reviewer would notice.
- 2: hard to read: run-on sentence, broken grammar, or fragments.
- 1: not readable as an answer.

### 2. Helpfulness (to the reviewer who asked)

- 5: answers exactly what was asked, first sentence first, nothing irrelevant.
- 4: answers what was asked with a little irrelevant detail.
- 3: answers the question only partly or indirectly.
- 2: mostly restates documents without answering the question.
- 1: does not answer the question.

## Pass threshold

An answer passes the judge when both scores are at least 3 and their mean is at least 3.5. The suite's
judge threshold is met when at least 90% of judged answers pass.

## Limits of the judge

- One model judging another model's text; scores vary between runs and the judge may favour its own
  style. Sonnet 5.5 does not accept a non-default `temperature`, so the judge runs at the default
  sampling settings, not temperature 0; scores are therefore not bit-for-bit reproducible.
- The rubric was written by the builder; there is no human-labelled calibration set.
- The judge runs only in `live` mode (it is a model call). Replay mode reports it as not run.
- A judge score never changes an answer's status, never overrides a code assertion, and never appears in
  the product.
