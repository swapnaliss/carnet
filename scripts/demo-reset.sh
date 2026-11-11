#!/usr/bin/env bash
# Puts the DEPLOYED demo business in the state the core-demo live run (M2-09) starts from.
#
#   ./scripts/demo-reset.sh                 # service name defaults to carnet-web
#
# What it does: runs `node runtime/demo-seed.mjs` as a Render one-off job on carnet-web (it uses the
# service's own environment and the app database role). The job idempotently adds the six dataset
# payees (fixtures/dataset/counterparties.json) to the demo business. It NEVER deletes or updates a
# row: payments, documents and RFIs of earlier runs stay, and every live run uses a fresh reference
# prefix, so "clean" means clean per run (owner decision, 2026-11-11). Safe to run any number of times.
#
# Needs the Render CLI logged in (`render whoami`). No secret is read or printed here.
set -euo pipefail

SERVICE_NAME="${1:-carnet-web}"
command -v render >/dev/null || { echo "render CLI not found" >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 not found" >&2; exit 2; }

SERVICE_ID="$(render services -o json --confirm | python3 -c '
import json, sys
name = sys.argv[1]
for item in json.load(sys.stdin):
    svc = item.get("service", item)
    if svc.get("name") == name:
        print(svc["id"])
        break
' "$SERVICE_NAME")"
[ -n "$SERVICE_ID" ] || { echo "service $SERVICE_NAME not found" >&2; exit 2; }

echo "starting demo seed job on $SERVICE_NAME ($SERVICE_ID)"
render jobs create "$SERVICE_ID" --start-command "node runtime/demo-seed.mjs" -o json --confirm
echo "read the result: render jobs list $SERVICE_ID -o json --confirm  (status 'succeeded'), logs: render logs -r $SERVICE_ID --limit 20 -o text"
