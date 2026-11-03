# Airwallex Transaction RFI contract (as documented, 2 Nov 2026)

Carnet is built on the behaviour below. Everything marked **UNKNOWN** is resolved by the M0 live sandbox spikes
(`fixtures/airwallex/`), and this file is updated with the observed behaviour. Sources: Airwallex developer docs
(`airwallex.com/docs/...`, pages fetched 2 Nov 2026) and the Airwallex docs MCP.

## RFI object and endpoints
- `GET /api/v1/rfis` (filters `statuses`, `types`, `from_created_at`, `end_created_at`, `page`, `page_size`), `GET /api/v1/rfis/{id}`, `POST /api/v1/rfis/{id}/respond`.
- Statuses `ACTION_REQUIRED`, `ANSWERED`, `CLOSED`. Types include `TRANSACTION`. An RFI has an `active_request` with `expires_at`; expiry moves the RFI to `CLOSED`.
- A question has `id`, `title{en,zh}`, `description`, `comment`, `answer{type}` and `sources[{id,type}]`. Transaction sources: `CHARGE`, `CONNECTED_ACCOUNT_TRANSFER`, `DIRECT_DEBIT`, `DEPOSIT`, `TRANSFER`.
- Answer types `TEXT`, `ATTACHMENT`, `IDENTITY_DOCUMENT`, `CONFIRMATION`, `LIVENESS`, `ADDRESS`.
- Respond body: `{questions:[{id, answer:{type, text | attachments:[{file_id}] | confirmed | address | identity_document, comment}}]}`; the docs error text "answer all questions" implies partial responses are rejected (**UNKNOWN** live). Responding is only valid in `ACTION_REQUIRED`.
- Webhooks `rfi.action_required`, `rfi.answered`, `rfi.closed` carry only `data.id` (the RFI id); the RFI must be fetched.

## Sandbox simulation
- `POST /api/v1/simulation/rfis/create` `{type, questions?[{answer.type, title{en}, description{en}, sources[]}]}`. "All RFIs for specified type must be in CLOSED status": **one open Transaction RFI at a time** per account.
- `POST /api/v1/simulation/rfis/{id}/follow_up` reopens answered questions by id and/or appends new ones; `POST /api/v1/simulation/rfis/{id}/close`.
- `x-on-behalf-of` is documented for platform accounts only. Whether a plain account can create simulated RFIs is **UNKNOWN** until the M0 spike.

## Transfers and RFIs
- An RFI does not add a transfer status. Transfer statuses (API version 2025-06-30 and later): `IN_APPROVAL`, `APPROVAL_RECALLED`, `APPROVAL_REJECTED`, `APPROVAL_BLOCKED`, `SCHEDULED`, `OVERDUE`, `PROCESSING`, `SENT`, `PAID`, `FAILED`, `CANCELLED`. An RFI may arrive while a transfer is `SCHEDULED`, `PROCESSING` or `SENT`.
- Answering or closing an RFI does not move the transfer: "Responding to or closing an RFI does not by itself send the transfer … the transfer outcome is decided by the review and may be `SENT` or `FAILED`." Carnet therefore derives payment status from the transfer, never from the RFI.
- How held funds appear in balances is **UNKNOWN** (M0 spike 8). Until measured, Carnet treats a held transfer's funds as unavailable.

## Files
- `POST https://files.sandbox.airwallex.com/api/v1/files/upload` multipart `file` (filename ≤ 50 characters), 20 MB maximum, returns `file_id` used in `answer.attachments[].file_id`. Accepted types for RFIs are **UNKNOWN**; Carnet always uploads PDF or JPEG.

## Webhooks
- Signature: `HMAC_SHA256(secret, x-timestamp + rawBody)`, hex, compared with `x-signature`. Delivery is at-least-once and unordered, retried with exponential backoff for about three days. Subscriptions are created in the web app only.

## Limits
- Sandbox (documented): 20 requests/second globally, 10 per endpoint, 10 concurrent; token lifetime 30 minutes; `request_id` unique for 7 days.
- Observed in M0-03 (`docs/evidence/airwallex-money-path.md`): 150 parallel balance reads in 1.3 s returned no 429; reusing a transfer `request_id` returns 400 `duplicate_request_id` with the existing transfer id in `details.id`; a simulated `FAILED` transfer is fetched as `CANCELLED` with a nested `failure` object.
