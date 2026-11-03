# Airwallex money path: observed sandbox behaviour (M0-03, 3 Nov 2026)

Everything below was observed against `api.sandbox.airwallex.com` with `scripts/spikes/airwallex/run-all.mjs`.
Fixtures are in `fixtures/airwallex/` (tokens, the API key and the client id are stripped by the recorder).
Where a fact comes from the Airwallex docs and not from a call, it says so. Amounts at the boundary are major units.

## Auth
- `POST /api/v1/authentication/login` with headers `x-client-id` and `x-api-key` returns 201 `{token, expires_at}` (`auth-login`). `expires_at` was about 30 minutes ahead.
- Wrong key: 401 `{code: "credentials_invalid", message: "UNAUTHORIZED", details: ["Access Denied"], source: ""}` (`auth-login-bad-key`).
- Invalid bearer token on a normal call: 401 `{code: "unauthorized", message: "Access denied, authentication failed"}` (`auth-invalid-token`). Expired-token behaviour was not waited out (30 min); treat it as the same 401 (**unverified**).

## Funding and balances
- The sandbox account starts with 10,000,000 in each of CNY, EUR, GBP, INR and USD, so no funding is needed for USD or EUR transfers.
- `GET /api/v1/global_accounts` returned one HK account (status `PROCESSING`, HKD only).
- `POST /api/v1/simulation/deposit/create` `{global_account_id, amount, currency, request_id}` returns 201 `{id, status: "PENDING", amount, currency, ...}` (`simulation-deposit-create`). The currency is forced to the account's (HKD); a USD request still credited HKD. The balance moved by the amount at once (`balances-funding-delta`: HKD 7000 to 8000).
- `GET /api/v1/balances/current` returns an array per currency `{currency, available_amount, pending_amount, reserved_amount, total_amount, prepayment_amount, account_type}`, in major units (`balances-before-funding`, `balances-after-transfer-create`). Creating a transfer debited `amount_payer_pays` from `available_amount` at once; `pending_amount` and `reserved_amount` stayed 0 (baseline for the M0-04 held-funds check).

## Beneficiaries
- Schema: `POST /api/v1/beneficiary_api_schemas/generate` with `{bank_country_code, account_currency, entity_type, transfer_method}`. The parameter is `transfer_method` (a single string); `payment_method` and `payment_methods` are rejected or match no schema (`beneficiary-schema-us-usd-local`, `beneficiary-schema-de-eur-swift`).
- US USD LOCAL requires: `entity_type`, `company_name`, `bank_details{account_currency, bank_country_code, account_routing_type1 "aba", account_routing_value1 (9 digits), account_number, account_name}`, `address{country_code, postcode, street_address, city, state "US-NY"}`, `type BANK_ACCOUNT`.
- DE EUR SWIFT requires `bank_details.iban` (`^DE\d{2}[a-zA-Z0-9]{18}$`) instead of routing and account number; address without state.
- **Docs gap:** the US request also needs `bank_details.bank_account_category` (`Checking`), which the generated schema does not list. Without it: 400 `validation_failed`, `details.errors[{code:"001", source:"beneficiary.bank_details.bank_account_category"}]`.
- Validate: `POST /api/v1/beneficiaries/validate` `{beneficiary, transfer_methods}` returns 200 `"OK"` or 400 `{code: "validation_failed", details: {errors: [{code, params?, source}]}}`. A 3-digit ABA gave codes `019` (`params.length: 9`) and `010` (`beneficiary-validate-bad`).
- Create: `POST /api/v1/beneficiaries/create` `{request_id, nickname, beneficiary, transfer_methods}` returns 201 with the id as **`id`** (not `beneficiary_id`). The bank name is filled in by Airwallex (`beneficiary-create-us-usd-local`, `beneficiary-create-de-eur-swift`).

## FX (no `x-api-version` header sent)
- `GET /api/v1/fx/rates/current?buy_currency&sell_currency&sell_amount` returns `rate`, `rate_details[{level AWX|CLIENT, rate, buy_amount, sell_amount}]` (`fx-current-rate`).
- `POST /api/v1/fx/quotes/create` `{buy_currency, sell_currency, sell_amount, validity}` returns `quote_id`, `client_rate`, `awx_rate`, `valid_from_at`, `valid_to_at`, `usage` (`fx-quote-create`). Valid `validity` values: `MIN_1`, `MIN_15`, `MIN_30`, `HR_1`, `HR_4`, `HR_8`, `HR_24`; `DAY_1` and `LOCKED` give 400 `invalid_argument`.
- **Differs from the project note "quotes are single-use":** every valid validity returned `usage: "MULTI_USE"`, and one quote converted twice with two different `request_id`s (`fx-conversion-from-quote`, `fx-conversion-from-quote-reused`, both 201 `SETTLED`, same rate). The sandbox does not enforce single use; treat quotes as short-lived and still create a fresh one per plan.
- `POST /api/v1/fx/conversions/create` `{request_id, buy_currency, sell_currency, sell_amount, reason, term_agreement: true, quote_id?}` returns 201 with the id as **`conversion_id`**, `status: "SETTLED"` immediately (`fx-conversion-create`); fetch by `GET /api/v1/fx/conversions/{id}` (`fx-conversion-fetch`). `GET /api/v1/fx/conversions` needs `page_size >= 10` (400 `invalid_argument` otherwise).

## Transfers
- `POST /api/v1/transfers/create` requires `request_id, beneficiary_id, source_currency, transfer_currency, source_amount (or transfer_amount), transfer_method, reason, reference, fee_paid_by`. Omitting `transfer_currency` gives 400 `validation_failed`, message `field [transfer_currency] is required` (`error-bad-json-field`).
- Created transfers come back 201 with status `SCHEDULED`, `funding.status: "FUNDED"` and move to `PROCESSING` by themselves within about a second (`transition-happy-paths`).
- Fees: LOCAL USD 25 gave `fee_amount 3`, `amount_payer_pays 28`; SWIFT EUR 30 gave `fee_amount 13.41`, `amount_payer_pays 43.41` (`transfer-create-local-usd`, `transfer-create-swift-eur`). The SWIFT flat fee is added on top when the payer pays.
- Fetch and list: `GET /api/v1/transfers/{id}` and `GET /api/v1/transfers` (`transfer-fetch-local`, `transfer-list`; list items are under `items`).
- **`request_id` reuse (same body and changed body alike):** 400 `{code: "duplicate_request_id", source: "request_id", details: {id: <existing transfer id>, request_id}, message: "...has been used for a transfer with the transfer ID ... before"}` (`transfer-reuse-request-id-same-body`, `transfer-reuse-request-id-changed-body`). It does not replay the original 201 and does not compare bodies. After a timeout, treat `duplicate_request_id` as "the transfer exists" and read `details.id`, then fetch it. No second transfer was created.
- Error shapes: 404 `{code: "not_found", message: "Transfer not found", source: ""}` (`error-transfer-not-found`); validation errors as above; 500 `{code: "operation_failed", message: "Request could not be processed"}` for an invalid simulation transition.

## Simulation transitions (`POST /api/v1/simulation/transfers/{id}/transition` `{next_status, failure_type?}`)
- The body field is `next_status` (docs, `https://www.airwallex.com/docs/api/simulation/transfers`, fetched 3 Nov 2026): `OVERDUE, PROCESSING, SENT, PAID, FAILED, CANCELLED`.
- Observed order that works: wait for the automatic `PROCESSING`, then `SENT`, then `PAID` (`transition-local-usd-sent`, `transition-local-usd-paid`, both routes). Asking for `PROCESSING` yourself returns 500 (`transition-processing-invalid`). `OVERDUE` from `PROCESSING` returns 500 (`transition-overdue`); it is probably valid only from `SCHEDULED` (**unverified**).
- `FAILED` is accepted from `SENT` and from `PAID` (`transition-paid-to-failed`: **`PAID` can still fail**). From `PROCESSING` it returns 500.
- `CANCELLED` is accepted from `PROCESSING` (`transition-cancelled`).
- **A simulated `FAILED` ends `CANCELLED` when fetched.** The transition response shows `status: "FAILED"`, but `GET /api/v1/transfers/{id}` returns `status: "CANCELLED"` (`transfer-fetch-failed-example`, `transfer-fetch-paid-then-failed`). The adapter must handle both and must not read `CANCELLED` as a person's cancel.
- All 32 documented `failure_type` values were accepted (200) (`transition-failure-types`). The simulator response always reports `failure_type: "INCORRECT_ROUTING"` with a per-input `failure_reason` such as `"90701: Account closed"`. The fetched transfer carries no top-level `failure_type` or `failure_reason`; it has `failure: {code: "90701", details: {type: "INCORRECT_ROUTING"}, message: "Account closed"}`. Read `failure.code`, `failure.message` and `failure.details.type`; keep the 32 input values only as simulator inputs.

## Rate limits and `x-request-id`
- Documented sandbox limit: 10 requests per second per endpoint. Observed: 150 parallel `GET /api/v1/balances/current` in 1.3 s (about 115 per second) all returned 200, with no `Retry-After` and no rate-limit headers (`rate-limit-burst`); the next call also succeeded (`rate-limit-recovered`). The limit is not enforced at that rate on this endpoint; other endpoints were not tested (**unverified**). The adapter still needs a 429 path with jittered backoff.
- Responses carried only `content-type` among the headers recorded; no `x-request-id` response header was seen. Correlation is by our own `request_id` in the body.
- Token reuse across calls worked for a whole run (login once, many calls).

## Not tested here
Expired-token behaviour (30 minute wait), `OVERDUE` from `SCHEDULED`, `x-api-version` on non-FX calls, RFIs, files and webhooks (M0-04, M0-05).
