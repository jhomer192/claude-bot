#!/usr/bin/env bash
# Stop hook for tmux-mode claude-bot.
#
# Installed into ~/.claude/settings.json (via scripts/setup-tmux-mode.sh).
# Fires after every Claude turn completes — interactive or -p mode.
#
# Receives JSON on stdin from the Claude CLI:
#   {
#     "session_id": "<uuid>",
#     "transcript_path": "/home/claude/.claude/projects/<slug>/<uuid>.jsonl",
#     "hook_event_name": "Stop",
#     ...
#   }
#
# Writes the transcript path to /var/lib/claude-bot/stop-signals/<session_id>
# so the bot's fs.watch picks it up and reads the new transcript content.
#
# Exit 0 always — never block the user's session because of bot signalling.

set -u

SIGNAL_DIR="${CLAUDE_BOT_SIGNAL_DIR:-/var/lib/claude-bot/stop-signals}"

# Make sure dir exists; setup script also does this but a missing dir on
# first run shouldn't kill the hook.
mkdir -p "$SIGNAL_DIR" 2>/dev/null || true

# Parse the JSON via python3 (universally available). jq fallback is fine
# but we avoid the extra system dep.
read_field() {
  python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print(d.get(sys.argv[1], ""))
except Exception:
    pass
' "$1"
}

payload=$(cat)
session_id=$(printf '%s' "$payload" | read_field session_id)
transcript_path=$(printf '%s' "$payload" | read_field transcript_path)

if [[ -z "$session_id" || -z "$transcript_path" ]]; then
  # Malformed payload; nothing useful to signal. Don't block the turn.
  exit 0
fi

# Atomic write so a partial read on the watcher side can't see half a path.
tmp=$(mktemp "$SIGNAL_DIR/.$session_id.XXXXXX")
printf '%s\n' "$transcript_path" > "$tmp"
mv -f "$tmp" "$SIGNAL_DIR/$session_id"

exit 0
