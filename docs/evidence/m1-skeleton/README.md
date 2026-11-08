# M1-08 walking skeleton: live evidence

One run against the deployed web service and the Airwallex sandbox, 8 Nov 2026
(`run-log.json`, produced by `scripts/skeleton-run.ts`; no cookies, passwords or tokens).

| Check | Result |
|---|---|
| Transfer created through the API and worker | transfer `40ac1ea9-293c-4d45-b3d4-e0ce3b5724ce`, attempt `CONFIRMED`, 1 send |
| Attempt row written before the outbound call | `row_before_call: true` |
| UI status follows the transfer | `PAID` |
| Real webhooks at the deployed URL | 7 received, all `signature_ok: true` |
| Ack and apply time | ack 4-13 ms, apply 0.8-1.1 s |
| Idempotency replay, viewer role | see `run-log.json` |

The 7 raw webhook bodies are in `fixtures/airwallex/m1-skeleton/`.

## Not shown by this run

- The sandbox simulates SENT and PAID, so this run says nothing about a real bank leg.
- A transfer that fails or is cancelled was not exercised here.

## Setup note

The Airwallex webhook subscription must point at the deployed `/api/webhooks/airwallex` URL.
Until it did, events stayed `Queued` in the Airwallex console and no request reached the service.
