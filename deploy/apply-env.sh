#!/usr/bin/env bash
# Runs ON the server, piped over SSH by the deploy workflow. Merges settings
# that come from GitHub repository secrets into server/.env, so credentials
# reach the box through the pipeline and nobody edits it by hand.
#
# The workflow appends the values to this script's own stdin as a heredoc
# (see the last line), so they are never on a command line, in `ps`, or in a
# log. Only the key NAMES are ever printed.
#
# Rules:
#   - only keys in ALLOWED are written; anything else is ignored
#   - an empty value is skipped, so a secret that isn't set never wipes a key
#     that already works
#   - nothing changes -> nothing restarts
#   - something changes -> back up .env, restart, health-check; if the service
#     doesn't come back, restore the backup and restart again
set -euo pipefail

ENV_FILE="$HOME/inhouse-plugin/server/.env"
ALLOWED=" R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY CF_ACCOUNT_ID CF_AI_TOKEN CF_AIG_GATEWAY_ID CF_AIG_TOKEN "

apply_env() {
  [ -f "$ENV_FILE" ] || { echo "==> $ENV_FILE not found"; exit 1; }
  local changed=() key val
  # Global, not local: the EXIT trap runs after this function has returned.
  TMP_ENV="$(mktemp "${ENV_FILE}.new.XXXXXX")"
  local tmp="$TMP_ENV"
  # The copy holds credentials: remove it on every exit path, including a rejected value.
  trap 'rm -f "${TMP_ENV:-}" "${TMP_ENV:-}.2"' EXIT
  chmod 600 "$tmp"
  cp "$ENV_FILE" "$tmp"

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    key="${line%%=*}"; val="${line#*=}"
    case "$ALLOWED" in *" $key "*) ;; *) echo "==> ignoring unknown key $key"; continue ;; esac
    [ -n "$val" ] || continue
    # One line, no quotes or whitespace: anything else would break the
    # systemd EnvironmentFile format and is not a plausible credential.
    if ! printf '%s' "$val" | grep -Eq '^[A-Za-z0-9._:/@+=-]+$'; then
      echo "==> rejecting $key: value has characters a credential shouldn't"; exit 1
    fi
    if grep -q "^${key}=" "$tmp"; then
      [ "$(sed -n "s/^${key}=//p" "$tmp" | head -1)" = "$val" ] && continue
      # Replace without putting the value through sed's pattern syntax.
      awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$tmp" > "$tmp.2" && mv "$tmp.2" "$tmp"
    else
      printf '%s=%s\n' "$key" "$val" >> "$tmp"
    fi
    chmod 600 "$tmp"
    changed+=("$key")
  done

  if [ "${#changed[@]}" -eq 0 ]; then
    rm -f "$tmp"
    echo "==> secrets: nothing to change"
    return 0
  fi

  local backup="${ENV_FILE}.bak.$(date +%s%N)"
  cp -p "$ENV_FILE" "$backup"
  mv "$tmp" "$ENV_FILE"
  echo "==> secrets updated: ${changed[*]}"

  local base url
  base="$(sed -n 's/^BASE_PATH=//p' "$ENV_FILE" | tr -d '[:space:]')"
  url="http://127.0.0.1:4317${base}/api/health"
  systemctl --user restart inhouse-plugin.service
  for _ in $(seq 1 20); do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      echo "==> healthy: $(curl -s "$url")"
      # Keep the three most recent backups; they hold credentials, so don't pile them up.
      ls -1t "${ENV_FILE}".bak.* 2>/dev/null | tail -n +4 | xargs -r rm -f
      return 0
    fi
    sleep 1
  done

  echo "==> HEALTH CHECK FAILED after updating secrets - restoring the previous .env" >&2
  cp -p "$backup" "$ENV_FILE"
  systemctl --user restart inhouse-plugin.service
  journalctl --user -u inhouse-plugin -n 30 --no-pager >&2 || true
  exit 1
}

apply_env <<'__INHOUSE_ENV__'
