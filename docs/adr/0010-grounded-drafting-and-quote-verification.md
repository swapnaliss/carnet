# ADR 0010: Grounded drafting with verbatim-quote verification

Status: accepted (2 Nov 2026)

## Context
A fluent answer that cites a hallucinated figure is worse than no answer; an extraction error would otherwise pass a verifier that checks only extracted facts.

## Decision
Extraction returns, for each fact, a verbatim quote and page; code verifies the quote against the PDF text layer (`unpdf`). Image-only documents require the owner to confirm each fact. The draft verifier checks that every citation exists and that every number, date and name in an answer appears in the cited facts; otherwise the question becomes NEEDS_OWNER. The approval screen shows the source snippet beside each claim. A mutation eval injects wrong numbers, dates and names into good drafts and must reject 100%.

## Alternatives considered
String matching on extracted facts only; trusting the model's confidence.

## Consequences
Cost to reverse: low.
