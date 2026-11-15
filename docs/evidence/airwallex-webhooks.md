# Airwallex webhooks: observed sandbox behaviour (M0-05, 4 Nov 2026)

Observed by subscribing the Render placeholder (`https://carnet-placeholder.onrender.com/api/webhooks/airwallex`,
Singapore, no tunnel) to `rfi.*` and `payout.transfer.*`, then driving the sandbox with
`scripts/spikes/airwallex/06-webhook-drive.mjs`. The receiver (`webhook-receiver.mjs`) logged each request's raw
headers and raw body; the deliveries were read back from the host's logs. Fixtures: `fixtures/airwallex/webhooks/`
(25 deliveries from run 2, plus `_delivery-order.json` listing both runs). Two runs, 4 Nov 2026 06:01 and 06:05 UTC.
Anything not listed here is not observed.

## Deviation from the ticket
The receiver on the host did **not** hold the signing secret (the Render CLI cannot set environment variables, and
a worker should not hold it), so it recorded `hmac: no-secret-on-server`. Signature checking was done offline by
`verify-hmac.mjs` with the secret from `.env`. Because the raw body had to stay byte-exact for that check, the
fixture bodies are not redacted; they hold only sandbox ids and the synthetic Northwind beneficiary. Infrastructure
headers (client IP, trace and ray ids) are replaced with `REDACTED`.

## Request shape
- `POST`, `content-type: application/json`, user agent `ReactorNetty/1.1.23`, arriving over HTTPS via Render's proxy.
- Airwallex's own headers are only `x-signature` and `x-timestamp`. There is no event-id header and no delivery-attempt header; the event id is in the body.
- `x-timestamp` is **epoch milliseconds** (for example `1793772318256`). `x-signature` is 64 hex characters.
- Body: `{id, name, account_id, data, created_at, version}`. `id` is the event id (uuid), `name` the event type, `created_at` has second resolution (`2026-11-04T06:05:18+0000`), `version` was `2026-08-21`.

## Signature (proved offline)
`x-signature = hex(HMAC_SHA256(secret, x-timestamp + rawBody))`, where `x-timestamp` is the header string as received and the body is the raw bytes.
`node scripts/spikes/airwallex/verify-hmac.mjs --dir fixtures/airwallex/webhooks --expect-valid` verifies **25 of 25** deliveries.
- **Tampered body** (one byte flipped, recorded signature): 25 of 25 fail (`sig=false`).
- **Stale timestamp** (timestamp 10 minutes before receipt, signature recomputed so it is genuinely valid): 25 of 25 fail on freshness only (`sig=true fresh=false`).
- **Tolerance to implement in M1-05: 5 minutes**, measured as `|server receipt time - x-timestamp|`. Observed `receipt - x-timestamp` was 13 ms to 601 ms across 59 events (median 50 ms), so 5 minutes leaves a wide margin. The docs' retry schedule can deliver much later than 5 minutes; a retry carried the **same** `x-timestamp` and signature as the first attempt (below), so a late retry will fail a freshness check. Treat a stale-but-validly-signed delivery as rejected (non-2xx) and rely on fetching the resource, never on the payload; this is unverified for retries beyond a few seconds because only the first retry was observed.
- Compare in constant time (`timingSafeEqual`) over the raw body, never over re-serialised JSON.

## Events seen
| `name` | `data` | Notes |
|---|---|---|
| `rfi.action_required` | `{id, type: "TRANSACTION"}` | on RFI creation; arrived about 10 ms after the create call returned |
| `rfi.answered` | `{id, type}` | after a full respond |
| `rfi.closed` | `{id, type}` | after the simulator close |
| `payout.transfer.scheduled` | full transfer object | on creation |
| `payout.transfer.processing` | full transfer object | |
| `payout.transfer.sent` | full transfer object | after the simulated `SENT` |
| `payout.transfer.paid` | full transfer object, `status: "PAID"` | |
| `payout.transfer.failed` | full transfer object, `status: "FAILED"`, `failure{code "99902", details.type "INCORRECT_ROUTING", message "Other"}` | after the simulated `FAILED` |
| `payout.transfer.cancelled` | full transfer object, `status: "CANCELLED"`, same `failure` | arrived about 240 ms after `failed`, same transfer |
| `payout.transfer.funding.scheduled`, `.processing`, `.funded` | full transfer object, `funding.status` | extra events the `payout.transfer.*` subscription also delivers |

Transfer events carry the whole transfer object in `data` (`id` is the transfer id, plus `status`, amounts, `request_id`, `beneficiary`). A simulated failure is announced twice, as `payout.transfer.failed` (`FAILED`) and then `payout.transfer.cancelled` (`CANCELLED`), while a fetch of the transfer returns `CANCELLED` (M0-03). The handler must accept both and derive status by fetching.

## `sources`
**The webhook does not carry `sources`.** The `rfi.*` bodies hold only `data.id` and `data.type`; no question, transfer id or source appears. The RFI must be fetched (`GET /api/v1/rfis/{id}`), and the fetched RFI carries `sources` on each question (M0-04, `airwallex-rfi-contract.md`). The transfer events do carry the transfer id, but nothing links it to an RFI.

## Ordering
Deliveries are **not** in occurrence order. A transfer is created as `SCHEDULED` and only later becomes `PROCESSING`, yet `payout.transfer.processing` arrived before `payout.transfer.scheduled` for two transfers (the run 1 transfer created at 06:01:56, received `processing`, `funding.processing`, `scheduled`, `funding.scheduled`, `funding.funded`; the run 2 transfer created at 06:05:16 received `processing` then `scheduled`). For another run 1 transfer the order received was `funding.processing`, `funding.funded`, **`sent`**, `funding.scheduled`, `scheduled`, `processing`: `payout.transfer.sent` arrived before `scheduled` and `processing`. The full per-delivery order is in `fixtures/airwallex/webhooks/_delivery-order.json`. The simulated steps made seconds apart (`sent`, then `paid`, or `sent`, `failed`, `cancelled`) arrived in order each time, but with 3 to 8 seconds between them that is not evidence of ordering. Consequence for M1-05: never apply an event as a state transition; on any event, fetch the transfer and project from it, and tolerate an event for an object it has not yet seen.

## Duplicates and retries
- A forced `500` on the first delivery of `rfi.closed` and of `payout.transfer.paid` produced an automatic redelivery **about 0.5 s later** (`rfi.closed` 06:05:34.934 to 06:05:35.460; `paid` 06:05:58.207 to 06:05:58.737).
- The redelivery had the **same event `id`, same `x-timestamp`, same `x-signature` and the same body** as the failed attempt (`fixtures/.../rfi.closed.1.json` and `rfi.closed.1-redelivery.json`). So the event id is stable across redeliveries and is the de-duplication key.
- No duplicate arrived without a forced failure: 59 distinct event ids over two runs, each delivered once when we returned 200.
- Only the first retry interval was observed (about 0.5 s). Later intervals and the retry horizon come from the docs and are unverified.

## Latency
`receipt - x-timestamp`: 13 to 601 ms, median 50 ms (59 events). `rfi.action_required` arrived about 10 ms after the create call returned. The first request after the placeholder had been idle needed a wake-up request first; a free Render instance sleeps after 15 minutes, which would add about a minute to a first delivery.

## Open
- Whether the 5-minute tolerance is what Airwallex intends is not stated in anything observed; it is Carnet's own project rule. Retries later than a few seconds were not observed.
- Behaviour when the endpoint is down for minutes or hours was not tested.
