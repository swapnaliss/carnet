# ADR 0008: Hash-bound, single-use approvals

Status: accepted (2 Nov 2026)

## Context
An approval must cover exactly what the approver saw, and cannot be replayed or applied to changed state.

## Decision
The approval hash is SHA-256 over canonical JSON of the business, approver, nonce and action, plus: for an RFI answer the RFI id and version, each question id and text, each answer text, attachment document ids and hashes, the evidence fact versions shown, the draft id and prompt version; for a payout the source account, beneficiary fingerprint, amount, currency, fee option, value date, reference and counterparty; for a conversion the currency pair, amount and rate bounds. Approvals expire before the RFI does. Consumption is one atomic `UPDATE ... WHERE status='APPROVED' AND hash=? RETURNING` in the same transaction as the attempt insert; the executor re-reads balance, quote and RFI state and re-derives the hash, refusing on mismatch.

## Alternatives considered
Role checks only; a signed token (adds nothing when the key is in the same process).

## Consequences
Cost to reverse: low.
