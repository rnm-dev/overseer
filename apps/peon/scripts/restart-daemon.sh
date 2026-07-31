#!/usr/bin/env bash
# Typechecks, refuses to restart over an in-flight session, restarts the
# daemon systemd service, then waits for the control API to come back.
#
# A restart kills whatever `claude -p` session is currently running (SIGTERM
# to the whole cgroup) - the daemon reports that honestly as an outcome, but
# there's no way to recover the run itself. Checking /api/status's `state`
# field is NOT a substitute for this check: it only reflects settings.paused,
# not whether a session is running.
set -euo pipefail

CONTROL_API="http://127.0.0.1:${ACA_CONTROL_PORT:-4570}"
SERVICE="peon-daemon.service"

echo "==> typecheck"
npx tsc --noEmit

echo "==> checking for an active session"
running=$(curl -sf "$CONTROL_API/api/sessions" | jq '[.sessions[] | select(.status == "running")] | length')
if [ "$running" -gt 0 ]; then
  echo "refusing to restart: a session is currently running (restarting kills it)" >&2
  echo "cancel it first in Overseer (or POST /api/v1/sessions/<id>/cancel), or re-run with FORCE=1" >&2
  if [ "${FORCE:-0}" != "1" ]; then
    exit 1
  fi
  echo "FORCE=1 set - restarting anyway" >&2
fi

echo "==> restarting $SERVICE"
systemctl --user restart "$SERVICE"

echo "==> waiting for control API to come back"
for _ in $(seq 1 30); do
  if curl -sf "$CONTROL_API/api/status" >/dev/null 2>&1; then
    echo "==> back up"
    curl -s "$CONTROL_API/api/status" | jq .
    exit 0
  fi
  sleep 1
done

echo "daemon did not come back within 30s" >&2
systemctl --user status "$SERVICE" --no-pager || true
exit 1
