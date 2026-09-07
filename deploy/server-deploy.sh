#!/usr/bin/env bash
# Runs ON the server. Pulls main, installs server deps, restarts the service and
# verifies it came back healthy. Piped in over SSH by the deploy workflow, so
# the copy that runs is always the one in the commit being deployed.
set -euo pipefail

APP="$HOME/inhouse-plugin"
URL="http://127.0.0.1:4317/api/health"

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
command -v node >/dev/null || { echo "node not found on PATH"; exit 1; }

echo "==> node $(node -v)"
PREV="$(git -C "$APP" rev-parse HEAD)"

git -C "$APP" fetch --quiet origin main
git -C "$APP" reset --quiet --hard origin/main
echo "==> ${PREV:0:7} -> $(git -C "$APP" rev-parse --short HEAD)  $(git -C "$APP" log -1 --format=%s)"

cd "$APP/server"
npm ci --omit=dev --no-audit --no-fund --silent

systemctl --user restart inhouse-plugin.service

for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 "$URL" >/dev/null 2>&1; then
    echo "==> healthy: $(curl -s "$URL")"
    exit 0
  fi
  sleep 1
done

echo "==> HEALTH CHECK FAILED — rolling back to ${PREV:0:7}" >&2
git -C "$APP" reset --quiet --hard "$PREV"
cd "$APP/server" && npm ci --omit=dev --no-audit --no-fund --silent
systemctl --user restart inhouse-plugin.service
journalctl --user -u inhouse-plugin -n 30 --no-pager >&2 || true
exit 1
