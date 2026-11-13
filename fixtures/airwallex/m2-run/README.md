# fixtures/airwallex/m2-run

Real Airwallex sandbox data from the M2-09 live run (2026-11-12 and 2026-11-13); see `docs/evidence/m2-run.md`.

- `webhooks/`: the 19 webhook events Carnet received, in order, as stored after the signature was verified (`raw_body` is the stored body; `account_id` is scrubbed to `acct_SCRUBBED`). The real signing secret is not in the repo: re-sign a body with a secret generated for the test before replaying it (as `scripts/skeleton-replay.ts` does).
- `respond-attempt.json`: the respond execution attempt as stored (status `CONFIRMED`, request id, the two attachments with their sha256 and Airwallex file ids). Only the data the product stored: it does not hold the raw HTTP bodies of the sandbox calls.

Synthetic business data; sandbox ids are not secrets.
