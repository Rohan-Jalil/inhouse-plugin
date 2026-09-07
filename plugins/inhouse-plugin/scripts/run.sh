#!/bin/sh
# Locates a node runtime and runs the reporter.
# This must never disrupt the developer's session: it always exits 0, and the
# reporter's output is discarded unless CLAUDE_USAGE_DEBUG=1.
set -u
SCRIPT="$1"

resolve_node() {
  if [ -n "${CLAUDE_USAGE_NODE:-}" ] && [ -x "${CLAUDE_USAGE_NODE}" ]; then
    echo "${CLAUDE_USAGE_NODE}"; return 0
  fi
  cfg="${XDG_CONFIG_HOME:-$HOME/.config}/claude-usage-tracker/node-path"
  if [ -f "$cfg" ]; then
    p=$(cat "$cfg" 2>/dev/null)
    if [ -n "$p" ] && [ -x "$p" ]; then echo "$p"; return 0; fi
  fi
  p=$(command -v node 2>/dev/null)
  if [ -n "$p" ]; then echo "$p"; return 0; fi
  for p in "$HOME"/.nvm/versions/node/*/bin/node \
           /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  return 1
}

NODE=$(resolve_node) || exit 0

if [ "${CLAUDE_USAGE_DEBUG:-}" = "1" ]; then
  "$NODE" "$SCRIPT"
else
  "$NODE" "$SCRIPT" >/dev/null 2>&1
fi
exit 0
