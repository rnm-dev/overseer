#!/usr/bin/env bash
set -euo pipefail

CONTAINER="overseer-app-1"
URL="http://127.0.0.1:4580/healthz"
MAX_RETRIES=25
WAIT_SEC=0.5

printf "Restarting Overseer app container (if needed)...\n"
docker compose restart app >/dev/null

echo "Waiting for HTTP health endpoint ${URL}" 
for i in $(seq 1 ${MAX_RETRIES}); do
  if curl -fsS "${URL}" >/dev/null 2>&1; then
    echo "OK: service is healthy (try ${i})."
    break
  fi
  if [[ "$i" == "${MAX_RETRIES}" ]]; then
    echo "ERROR: health check timed out." >&2
    docker compose logs --tail=120 app
    exit 1
  fi
  sleep "${WAIT_SEC}"
done

echo "\nLast 80 log lines:" 
docker compose logs --tail=80 app

echo "\nModule import errors since restart:" 
docker compose logs --since=2m app | grep -E "ERR_MODULE_NOT_FOUND|Cannot find module" || true
