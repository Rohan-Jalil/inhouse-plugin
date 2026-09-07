#!/usr/bin/env bash
# Enrolls this machine in Claude Code usage tracking.
#
#   curl -fsSL https://raw.githubusercontent.com/Rohan-Jalil/inhouse-plugin/main/install.sh \
#     | bash -s -- --endpoint https://usage.example.com/api/ingest --token <token>
#
#   ./install.sh --endpoint https://usage.example.com/api/ingest \
#                --token <ingest-token> \
#                [--name "Full Name"] [--email you@company.com] \
#                [--source owner/repo | /local/path]   (default: the public repo)
#
# Re-running is safe: it updates the config in place.

set -euo pipefail

ENDPOINT="${CLAUDE_USAGE_ENDPOINT:-}"
TOKEN="${CLAUDE_USAGE_TOKEN:-}"
NAME=""
EMAIL=""
SOURCE=""
NONINTERACTIVE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --endpoint) ENDPOINT="$2"; shift 2 ;;
    --token)    TOKEN="$2";    shift 2 ;;
    --name)     NAME="$2";     shift 2 ;;
    --email)    EMAIL="$2";    shift 2 ;;
    --source)   SOURCE="$2";   shift 2 ;;
    --yes|-y)   NONINTERACTIVE=1; shift ;;
    -h|--help)  sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
say() { echo "  $*"; }

# Read one answer from the terminal. Never reads stdin: when this script is run
# as `curl … | bash`, stdin is the script's own source and reading it would
# swallow the rest of the script.
ask_secret() { # ask_secret <prompt> -> echoes the answer, no echo to the terminal
  if [ "$NONINTERACTIVE" = "1" ] || [ ! -r /dev/tty ]; then echo ""; return; fi
  printf '  %s' "$1" > /dev/tty
  stty -echo < /dev/tty 2>/dev/null || true
  IFS= read -r _s < /dev/tty || _s=""
  stty echo < /dev/tty 2>/dev/null || true
  printf '\n' > /dev/tty
  echo "$_s"
}

ask() { # ask <prompt> <default> -> echoes the answer
  _d="$2"
  if [ "$NONINTERACTIVE" = "1" ] || [ ! -r /dev/tty ]; then echo "$_d"; return; fi
  printf '  %s' "$1" > /dev/tty
  IFS= read -r _a < /dev/tty || _a=""
  [ -n "$_a" ] && echo "$_a" || echo "$_d"
}

echo
echo "Claude Code usage tracking — setup"
echo "──────────────────────────────────"

# ---------------------------------------------------------------- node check
NODE=""
if command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  for c in "$HOME"/.nvm/versions/node/*/bin/node /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$c" ] && { NODE="$c"; break; }
  done
fi
[ -n "$NODE" ] || die "Node.js not found. Install Node 18+ and re-run."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node 18+ required (found $("$NODE" -v))."
say "node        $("$NODE" -v)  ($NODE)"

command -v claude >/dev/null 2>&1 || die "The 'claude' CLI is not on PATH."
say "claude      $(claude --version 2>/dev/null | head -1)"

# ------------------------------------------------------------------- identity
if [ -z "$NAME" ]; then
  NAME="$(git config --global user.name 2>/dev/null || true)"
  NAME="$(ask "Your full name [${NAME}]: " "$NAME")"
fi
if [ -z "$EMAIL" ]; then
  EMAIL="$(git config --global user.email 2>/dev/null || true)"
  EMAIL="$(ask "Your work email [${EMAIL}]: " "$EMAIL")"
fi
[ -n "$NAME" ]  || die "A name is required (--name)."
[ -n "$EMAIL" ] || die "An email is required (--email)."

if [ -z "$ENDPOINT" ]; then
  ENDPOINT="$(ask "Ingest endpoint URL: " "")"
fi
[ -n "$ENDPOINT" ] || die "An endpoint is required (--endpoint)."

if [ -z "$TOKEN" ]; then
  TOKEN="$(ask_secret 'Ingest token: ')"
fi
[ -n "$TOKEN" ] || die "An ingest token is required (--token). Without it the server rejects every report."

case "$ENDPOINT" in
  https://*) ;;
  http://localhost*|http://127.0.0.1*) echo "  note: plaintext endpoint (local) — fine for testing" ;;
  http://*) echo "  WARNING: reports will be sent unencrypted over http://" >&2 ;;
  *) die "Endpoint must be a URL." ;;
esac

# --------------------------------------------------------------------- config
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/claude-usage-tracker"
mkdir -p "$CONFIG_DIR"

"$NODE" -e '
  const fs = require("fs"), path = require("path");
  const [dir, name, email, endpoint, token] = process.argv.slice(1);
  const file = path.join(dir, "config.json");
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const cfg = {
    ...prev,
    enabled: true,
    endpoint,
    token,
    developer: { name, email },
    flushIntervalSec: prev.flushIntervalSec ?? 60,
    redactContent: prev.redactContent ?? false,
  };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
' "$CONFIG_DIR" "$NAME" "$EMAIL" "$ENDPOINT" "$TOKEN"

chmod 600 "$CONFIG_DIR/config.json"
printf '%s' "$NODE" > "$CONFIG_DIR/node-path"
say "config      $CONFIG_DIR/config.json"

# -------------------------------------------------------------------- plugin
# Default to the published marketplace; --source overrides it with a local
# checkout when you are testing changes before pushing them.
if [ -z "$SOURCE" ]; then
  SOURCE="Rohan-Jalil/inhouse-plugin"
fi

if claude plugin marketplace list 2>/dev/null | grep -q 'inhouse-plugin'; then
  claude plugin marketplace update inhouse-plugin >/dev/null 2>&1 || true
  say "marketplace inhouse-plugin (updated)"
else
  claude plugin marketplace add "$SOURCE" >/dev/null || die "Could not add the marketplace from $SOURCE"
  say "marketplace inhouse-plugin (added from $SOURCE)"
fi

claude plugin install inhouse-plugin@inhouse-plugin >/dev/null 2>&1 \
  || claude plugin enable inhouse-plugin@inhouse-plugin >/dev/null 2>&1 \
  || die "Could not install inhouse-plugin@inhouse-plugin"
say "plugin      inhouse-plugin@inhouse-plugin enabled"

# ------------------------------------------------------------------ verify
echo
echo "Verifying the reporter can reach the server…"

# Post a deliberately invalid body: the server answers 400 once authenticated
# and 401 when the token is wrong, so this proves the token without writing a
# session row.
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -X POST "$ENDPOINT" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{}' 2>/dev/null || echo 000)"

case "$CODE" in
  400) echo "  OK — endpoint reachable and token accepted." ;;
  401|403)
    die "the server rejected this token (HTTP $CODE). Check --token against INGEST_TOKEN on the server." ;;
  000)
    echo "  WARNING: could not reach $ENDPOINT. Reports will be spooled locally and retried." >&2 ;;
  404)
    die "no ingest endpoint at $ENDPOINT (HTTP 404). Check the URL — it usually ends in /api/ingest." ;;
  *)
    echo "  WARNING: unexpected response from the server (HTTP $CODE)." >&2 ;;
esac

cat <<EOF

Done. Usage from your next Claude Code session onward is reported as:
  ${NAME} <${EMAIL}>

To stop reporting:  set "enabled": false in $CONFIG_DIR/config.json
To remove entirely: claude plugin uninstall inhouse-plugin@inhouse-plugin
EOF
