#!/bin/sh
set -eu
case "${PROCESS_MODE:-web}" in
  web) exec node apps/web/server.js ;;
  worker) exec node worker.ts ;;
  *) echo "unknown PROCESS_MODE: ${PROCESS_MODE}" >&2; exit 2 ;;
esac
