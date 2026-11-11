#!/usr/bin/env bash
# Exports what a live core-demo run left in the deployed database (M2-09), read-only.
#
#   ./scripts/demo-export.sh <since-iso> <out.jsonl>     e.g. 2026-11-11T12:00:00Z "$TMPDIR/run.jsonl"
#
# Runs `node runtime/demo-export.mjs` as a Render one-off job on carnet-web (see scripts/demo-export.ts for
# what it selects and drops), waits for it, and writes its JSON log lines to <out.jsonl>. The output is
# unscrubbed raw rows of synthetic data: scrub and review it before anything is committed.
# Needs the Render CLI logged in. No secret is read or printed here.
set -euo pipefail

SINCE="${1:?usage: demo-export.sh <since-iso> <out.jsonl>}"
OUT="${2:?usage: demo-export.sh <since-iso> <out.jsonl>}"
SERVICE_NAME="${SERVICE_NAME:-carnet-web}"
[[ "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$ ]] || { echo "since must look like 2026-11-11T12:00:00Z" >&2; exit 2; }

SERVICE_ID="$(render services -o json --confirm | python3 -c '
import json, sys
for item in json.load(sys.stdin):
    svc = item.get("service", item)
    if svc.get("name") == sys.argv[1]:
        print(svc["id"]); break
' "$SERVICE_NAME")"
[ -n "$SERVICE_ID" ] || { echo "service $SERVICE_NAME not found" >&2; exit 2; }

JOB_ID="$(render jobs create "$SERVICE_ID" --start-command "env EXPORT_SINCE=$SINCE node runtime/demo-export.mjs" -o json --confirm \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
echo "export job $JOB_ID started"

for _ in $(seq 1 60); do
  STATUS="$(render jobs list "$SERVICE_ID" -o json --confirm | python3 -c '
import json, sys
for j in json.load(sys.stdin):
    if j["id"] == sys.argv[1]:
        print(j["status"]); break
' "$JOB_ID")"
  case "$STATUS" in succeeded|failed|canceled) break ;; esac
  sleep 5
done
echo "job status: $STATUS"
sleep 5   # the last log lines arrive a few seconds after the job ends
render logs -r "$JOB_ID" --limit 20000 --direction forward -o text --confirm \
  | python3 -c '
import sys
for line in sys.stdin:
    i = line.find("{")
    if i >= 0 and "\"process\":\"demo-export\"" in line[i:]:
        sys.stdout.write(line[i:].rstrip("\n") + "\n")
' > "$OUT"
echo "wrote $(wc -l < "$OUT") lines to $OUT"
[ "$STATUS" = "succeeded" ]
