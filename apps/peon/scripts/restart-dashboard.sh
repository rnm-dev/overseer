#!/usr/bin/env bash
# The dashboard is a static file server with no in-flight-work concept (JSX
# changes need no restart at all - only its own server.ts does), so this is
# just typecheck + restart + a liveness check, no idle/session guard needed.
set -euo pipefail

DASHBOARD_URL="http://127.0.0.1:${ACA_DASHBOARD_PORT:-4571}"
SERVICE="peon-dashboard.service"

echo "==> typecheck"
npx tsc --noEmit

echo "==> restarting $SERVICE"
systemctl --user restart "$SERVICE"

echo "==> waiting for dashboard to come back"
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null "$DASHBOARD_URL"; then
    echo "==> back up at $DASHBOARD_URL"
    exit 0
  fi
  sleep 1
done

echo "dashboard did not come back within 30s" >&2
systemctl --user status "$SERVICE" --no-pager || true
exit 1
