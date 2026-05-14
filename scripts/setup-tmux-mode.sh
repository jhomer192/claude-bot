#!/usr/bin/env bash
# Install the tmux-mode Stop hook into the service user's Claude settings.
#
# Idempotent: re-running adds the hook if absent, skips if already there.
#
# Production usage:
#   sudo ./setup-tmux-mode.sh
#
# Local dev (no systemd, no /var/lib):
#   CLAUDE_BOT_SIGNAL_DIR=/tmp/claude-bot-signals \
#   CLAUDE_USER=$USER \
#   CLAUDE_SETTINGS=$HOME/.claude/settings.json \
#     ./setup-tmux-mode.sh

set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }

CLAUDE_USER="${CLAUDE_USER:-claude}"
CLAUDE_HOME="${CLAUDE_HOME:-/home/$CLAUDE_USER}"
CLAUDE_SETTINGS="${CLAUDE_SETTINGS:-$CLAUDE_HOME/.claude/settings.json}"
SIGNAL_DIR="${CLAUDE_BOT_SIGNAL_DIR:-/var/lib/claude-bot/stop-signals}"

# Resolve the hook script absolute path relative to this script's location.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_SCRIPT="$(cd "$HERE/.." && pwd)/hooks/on-stop.sh"
[[ -x "$HOOK_SCRIPT" ]] || die "hook script not executable: $HOOK_SCRIPT"

command -v jq >/dev/null 2>&1 || die "jq required but not installed"

# 1) Signal directory. Service user needs to write here.
mkdir -p "$SIGNAL_DIR"
if [[ $EUID -eq 0 ]]; then
  chown "$CLAUDE_USER:$CLAUDE_USER" "$SIGNAL_DIR"
fi
chmod 755 "$SIGNAL_DIR"
echo "✓ signal dir: $SIGNAL_DIR"

# 2) Merge the hook into settings.json. Preserves existing keys.
mkdir -p "$(dirname "$CLAUDE_SETTINGS")"
if [[ ! -f "$CLAUDE_SETTINGS" ]]; then
  echo '{}' > "$CLAUDE_SETTINGS"
fi

# Back up before mutating.
backup="${CLAUDE_SETTINGS}.bak.$(date +%Y%m%d-%H%M%S)"
cp "$CLAUDE_SETTINGS" "$backup"
echo "✓ backed up: $backup"

# Build the desired Stop-hook entry. We match by exact command string so a
# re-run doesn't duplicate.
new_settings=$(jq \
  --arg cmd "$HOOK_SCRIPT" \
  '
  .hooks //= {} |
  .hooks.Stop //= [] |
  if [.hooks.Stop[]?.hooks[]?.command] | index($cmd) | not then
    .hooks.Stop += [{
      "hooks": [{"type": "command", "command": $cmd}]
    }]
  else . end
  ' "$CLAUDE_SETTINGS")

# Atomic replace.
tmp=$(mktemp "${CLAUDE_SETTINGS}.XXXXXX")
printf '%s\n' "$new_settings" > "$tmp"
if [[ $EUID -eq 0 ]]; then
  chown "$CLAUDE_USER:$CLAUDE_USER" "$tmp"
fi
chmod 644 "$tmp"
mv -f "$tmp" "$CLAUDE_SETTINGS"
echo "✓ Stop hook installed in $CLAUDE_SETTINGS"

# 3) Sanity check: the entry is parseable and points at our script.
got=$(jq -r --arg cmd "$HOOK_SCRIPT" '
  [.hooks.Stop[]?.hooks[]? | select(.command == $cmd) | .command] | length
' "$CLAUDE_SETTINGS")
if [[ "$got" != "1" ]]; then
  die "verification failed: expected exactly 1 matching hook entry, got $got"
fi

echo ""
echo "Done. Verify with:"
echo "  ./scripts/poc-tmux-claude.sh"
