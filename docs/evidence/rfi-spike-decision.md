# M0-04 decision: plain account creates RFIs: yes (3 Nov 2026)

**Result of check 1:** a plain sandbox account (no `x-on-behalf-of`) creates simulated `TRANSACTION` RFIs with `POST /api/v1/simulation/rfis/create`, with TEXT and ATTACHMENT questions and a `TRANSFER` source (`fixtures/airwallex/rfi-check1-create.json`, status 200). The fallback in ADR 0018 (local injection of the documented webhook shape) is **not needed** for the core flow. Replay mode in ADR 0018 stays as designed (a labelled replay of a recorded real run for judges).

## The eight checks

| # | Check | Observed (fixtures `rfi-check<n>-*`) |
|---|---|---|
| 1 | Plain-account creation | Works. The `TRANSFER` source needs a transfer already `PROCESSING`; right after creation it fails with 400 "Invalid source". Transfer status unchanged by the RFI. Webhook payload pending M0-05. |
| 2 | Partial and repeated respond | Partial rejected (400 "Please answer all questions in the request"); full accepted, RFI `ANSWERED`; respond again 400 `invalid_state_for_operation`. |
| 3 | Files | PNG, JPEG, PDF accepted by upload and respond. `.txt` rejected at upload (`invalid_file_extension`, list of allowed extensions in the body). A 22 MB file was accepted (documented limit not enforced). |
| 4 | Transfer transitions while open | `SENT`, `PAID` and `FAILED` (fetched `CANCELLED`) all work; the RFI stays `ACTION_REQUIRED`. Occasional 500 on a transition that was applied. |
| 5 | Close | 200, RFI `CLOSED`; transfer unchanged (`PROCESSING`); respond after close 400; close twice 400. |
| 6 | Long TEXT | 20,000,000 characters accepted; no limit found. |
| 7 | Sources | Present on each question in create and fetch; a second source on a question is dropped; no sources gives a synthetic `DEPOSIT` source. |
| 8 | Held funds | Balance debited at transfer creation; `pending_amount` and `reserved_amount` stay 0 while the RFI is open. |

Also: `follow_up` reopens and appends (repeated title accepted); the one-open rule applies per type and source.

## Differences from the documented contract and from our project notes
1. **One open RFI per account (CLAUDE.md, PROJECT.md, `docs/evidence`) is wrong as stated.** The sandbox rejects a second RFI for the same type **and source**; RFIs on other sources, or with none, coexist. Planning that assumes one open RFI per account is stricter than needed, not unsafe. Proposed ADR 0018 amendment: do not rely on a global exclusive account; keep a per-source guard in our own state.
2. **A true orphan RFI cannot be simulated**: no sources produces a synthetic `DEPOSIT` source. The orphan queue (M2-04) needs a test that injects an RFI whose source we do not know, not an API-created one.
3. **Limits are not enforced in the sandbox** (20 MB file, text length). Carnet enforces its own caps and must not claim Airwallex limits it has not verified.
4. Held funds are visible only as the debit at creation, not as a separate held amount.

## For the owner
The organiser question from M0-01 (can a plain account create simulated RFIs) is answered by this result; you can drop it from the list or tell the organisers the answer. The remaining open question is the webhook payload for RFIs (M0-05).
