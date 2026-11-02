---
title: "M0-05 · Webhook receive spike: subscription, HMAC, payload (sources?), ordering; fixtures"
milestone: "M0 · Recon & Bootstrap"
labels: ["recon"]
blocked_by: ["M0-04", "M0-07"]
estimate: "3h"
resources: ["AIRWALLEX_SANDBOX"]
needs: ["P-03", "P-05", "P-06"]
---

## Context

Webhooks drive the RFI intake and payment projection (ADR 0005 outbox and worker; ADR 0006 payment status as projection). The docs say delivery is at-least-once and unordered and the signature is `HMAC_SHA256(secret, x-timestamp + rawBody)` compared with `x-signature`, but nothing has been observed. Check 7 of M0-04 left "does the webhook carry sources?" partly open. The route that ships is M1-05; this spike only records truth so that route and its tests use real payloads (rubric R0; CLAUDE.md: tests replay recorded real responses).

## Scope

1. **Receiver.** A throwaway Node script `scripts/spikes/airwallex/webhook-receiver.mjs` (no dependencies; not the production route) that listens on a port, records raw headers and the raw body bytes of every request to `$TMPDIR` and then to redacted fixtures, verifies the HMAC over `x-timestamp + rawBody` with the secret from `AIRWALLEX_WEBHOOK_SECRET` (never printed), and returns 200. It also records the result for a tampered body and a stale timestamp (offline, with a locally computed signature) to settle the tolerance policy to implement in M1-05.
2. **Subscription (owner action).** The owner creates the webhook subscription in the Airwallex web app (Developer > Webhooks; subscriptions cannot be created by API) pointing at the public HTTPS URL of the placeholder container from M0-07, or at a `cloudflared` quick tunnel to the local receiver, subscribing to `rfi.*` and `payout.transfer.*`, and puts the signing secret in `.env` as `AIRWALLEX_WEBHOOK_SECRET` (a worker never sees it). A worker may draft the click path. If the receiver is deployed to the M0-07 container, it is replaced by the real image later.
3. **Drive events** using the M0-04 helpers: create a transfer, create and answer, follow up and close an RFI, transition the transfer through `SENT`, `PAID` and `FAILED`.
4. **Record**: full headers (names stable, values redacted where they hold secrets), body shape for each `rfi.action_required`, `rfi.answered`, `rfi.closed` and each `payout.transfer.*` event, whether `sources` or transfer ids appear, event `id` stability across redeliveries, order versus occurrence order, duplicates (force one by returning 500 once), retry timing seen, and delivery latency.
5. Add findings to `docs/evidence/airwallex-rfi-contract.md` (Webhooks section) and `docs/evidence/airwallex-webhooks.md`.

## Out of scope

- The production webhook route, idempotent inbox or outbox (M1-05)
- Any change to the subscription in production terms (single subscription per environment is decided in M1-06)
- Auto-creating subscriptions (impossible by API)

## Acceptance Criteria

- [ ] At least one delivery of each: `rfi.action_required`, `rfi.answered`, `rfi.closed`, and `payout.transfer.*` for PROCESSING, SENT, PAID and FAILED is recorded as a redacted fixture in `fixtures/airwallex/webhooks/`
- [ ] The recorded raw body and `x-timestamp` verify against the recorded `x-signature` using an offline script (proves the HMAC construction)
- [ ] A tampered body and a stale timestamp are shown to fail verification, and the evidence file states the timestamp tolerance to use
- [ ] Ordering and duplicate behaviour are written down with the events that show them
- [ ] The evidence file states whether the webhook or the fetched RFI carries `sources`
- [ ] No webhook secret appears in any tracked file, fixture or log

## Deliverables

- `scripts/spikes/airwallex/webhook-receiver.mjs`, `scripts/spikes/airwallex/verify-hmac.mjs`
- `fixtures/airwallex/webhooks/*.json` (headers and raw body, secret-bearing values redacted)
- `docs/evidence/airwallex-webhooks.md`; updated `docs/evidence/airwallex-rfi-contract.md`

## Validation Gate

```bash
set -euo pipefail
T="${TMPDIR:-/tmp}/m0-05"; rm -rf "$T"; mkdir -p "$T"
test -n "${AIRWALLEX_WEBHOOK_SECRET:-}" || { echo "missing webhook secret (owner step)" >&2; exit 2; }
d=fixtures/airwallex/webhooks
for p in rfi.action_required rfi.answered rfi.closed payout.transfer; do ls "$d" | grep -q "$p" || { echo "missing $p" >&2; exit 1; }; done
node scripts/spikes/airwallex/verify-hmac.mjs --dir "$d" --expect-valid >"$T/valid.txt"
node scripts/spikes/airwallex/verify-hmac.mjs --dir "$d" --tamper --expect-invalid >"$T/tamper.txt"
node scripts/spikes/airwallex/verify-hmac.mjs --dir "$d" --stale --expect-invalid >"$T/stale.txt"
! grep -R -F "$AIRWALLEX_WEBHOOK_SECRET" fixtures docs/evidence scripts "$T"
grep -q -i 'sources' docs/evidence/airwallex-webhooks.md
grep -q -i 'order' docs/evidence/airwallex-webhooks.md && grep -q -i 'duplicate' docs/evidence/airwallex-webhooks.md
./scripts/check-no-secrets.sh
```

## Handoff

- M1-05 (webhook route) needs the fixtures, the verified HMAC construction, the tolerance and the ordering/duplicate rules; M1-03's contract tests replay the same fixtures.
- M2-* RFI intake needs the answer on `sources` in the payload.
- Post on the issue: the event table (type, shape summary, ordering), the tolerance decision, and whether a tunnel or the M0-07 URL was used.
