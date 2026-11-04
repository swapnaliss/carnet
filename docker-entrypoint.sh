#!/bin/sh
set -eu
case "${PROCESS_MODE:-web}" in
  web) exec node webhook-receiver.mjs ;; # TEMP M0-05: revert before merge
  webhook-spike) exec node webhook-receiver.mjs ;;
  worker) exec node worker.ts ;;
  *) echo "unknown PROCESS_MODE: ${PROCESS_MODE}" >&2; exit 2 ;;
esac
