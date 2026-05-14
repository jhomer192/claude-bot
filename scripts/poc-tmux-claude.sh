#!/usr/bin/env bash
# Proof-of-concept: drive `claude` interactively in tmux, detect turn
# completion via Stop hook, parse the transcript JSONL.
#
# This is the bot's full feedback loop, minus Telegram. If this exits 0,
# the architecture works and we can wire it into telegram.ts.
#
# Usage:
#   ./poc-tmux-claude.sh
#   ./poc-tmux-claude.sh "what is 2 + 2"   # override default prompt

set -euo pipefail

trap_msg() { echo "[poc] $*" >&2; }

PROMPT="${1:-Reply with exactly the word: PONG}"
POC_DIR=$(mktemp -d -t tmux-poc-XXXX)
SIGNAL_DIR="$POC_DIR/signals"
SETTINGS_FILE="$POC_DIR/settings.json"
SESSION_ID=$(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')
TMUX_SESSION="poc-claude-${SESSION_ID:0:8}"
CWD="$POC_DIR/workdir"
HOOK_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/hooks/on-stop.sh"

mkdir -p "$SIGNAL_DIR" "$CWD"

# Pre-trust the cwd in ~/.claude.json so the interactive trust dialog
# doesn't intercept our first send-keys. Atomic JSON merge via python3.
# In production tmux-mode this same merge runs on every new chat cwd.
CLAUDE_JSON="${CLAUDE_JSON_OVERRIDE:-$HOME/.claude.json}"
python3 - "$CLAUDE_JSON" "$CWD" <<'PY'
import json, os, sys, tempfile
path, cwd = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        data = json.load(f)
except FileNotFoundError:
    data = {}
projects = data.setdefault("projects", {})
entry = projects.setdefault(cwd, {})
entry["hasTrustDialogAccepted"] = True
entry["projectOnboardingSeenCount"] = max(entry.get("projectOnboardingSeenCount", 0), 99)
tmp = tempfile.NamedTemporaryFile("w", dir=os.path.dirname(path), delete=False)
json.dump(data, tmp, indent=2)
tmp.flush()
os.fsync(tmp.fileno())
tmp.close()
os.replace(tmp.name, path)
PY

cleanup() {
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  trap_msg "kept temp dir for inspection: $POC_DIR"
}
trap cleanup EXIT

[[ -x "$HOOK_SCRIPT" ]] || { echo "hook script not executable: $HOOK_SCRIPT" >&2; exit 1; }
command -v claude  >/dev/null 2>&1 || { echo "claude CLI not found" >&2; exit 1; }
command -v tmux    >/dev/null 2>&1 || { echo "tmux not found" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found" >&2; exit 1; }

# Build a self-contained settings.json that points Stop → our hook.
cat > "$SETTINGS_FILE" <<JSON
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {"type": "command", "command": "$HOOK_SCRIPT"}
        ]
      }
    ]
  }
}
JSON

trap_msg "session_id:   $SESSION_ID"
trap_msg "tmux session: $TMUX_SESSION"
trap_msg "signal dir:   $SIGNAL_DIR"
trap_msg "prompt:       $PROMPT"

# Spawn claude inside tmux. --settings + --session-id pin everything to
# values we control. CLAUDE_BOT_SIGNAL_DIR must be exported into the
# tmux env so the hook writes where we expect.
tmux new-session -d -s "$TMUX_SESSION" -e "CLAUDE_BOT_SIGNAL_DIR=$SIGNAL_DIR" \
  -c "$CWD" \
  "claude --settings '$SETTINGS_FILE' --session-id '$SESSION_ID'"

trap_msg "tmux spawned, waiting 4s for claude to render its prompt…"
sleep 4

# Send the prompt as literal chars, then Enter.
tmux send-keys -t "$TMUX_SESSION" -l "$PROMPT"
tmux send-keys -t "$TMUX_SESSION" Enter
trap_msg "prompt sent, waiting for Stop signal at $SIGNAL_DIR/$SESSION_ID …"

# Poll up to 90s for the signal file to appear.
deadline=$(( $(date +%s) + 90 ))
signal_file="$SIGNAL_DIR/$SESSION_ID"
while (( $(date +%s) < deadline )); do
  if [[ -f "$signal_file" ]]; then
    break
  fi
  sleep 0.5
done

if [[ ! -f "$signal_file" ]]; then
  trap_msg "FAIL: no signal after 90s. tmux pane tail:"
  tmux capture-pane -t "$TMUX_SESSION" -p -S -200 >&2 || true
  exit 1
fi

transcript_path=$(cat "$signal_file")
trap_msg "✓ Stop hook fired. transcript: $transcript_path"
[[ -f "$transcript_path" ]] || { trap_msg "FAIL: transcript path doesn't exist"; exit 1; }

trap_msg "parsing transcript for the assistant's reply…"
# Stop hook can fire ~hundreds of ms before the transcript flush completes.
# Retry the read up to ~3s, looking for either an assistant text block or
# a stop_hook_summary system marker (terminal indicator).
reply=$(python3 - "$transcript_path" <<'PY'
import json, sys, time
path = sys.argv[1]
deadline = time.time() + 3.0
while True:
    texts, terminal = [], False
    try:
        with open(path) as f:
            for line in f:
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                if ev.get("type") == "assistant":
                    for block in (ev.get("message", {}) or {}).get("content", []) or []:
                        if isinstance(block, dict) and block.get("type") == "text":
                            texts.append(block.get("text", ""))
                elif ev.get("type") == "system" and ev.get("subtype") == "stop_hook_summary":
                    terminal = True
    except FileNotFoundError:
        pass
    if terminal and texts:
        print(texts[-1])
        break
    if time.time() > deadline:
        # Best effort: print whatever we have so the operator can see something.
        if texts:
            print(texts[-1])
        break
    time.sleep(0.1)
PY
)

if [[ -z "$reply" ]]; then
  trap_msg "FAIL: transcript has no assistant text block"
  trap_msg "transcript head:"
  head -5 "$transcript_path" >&2
  exit 1
fi

echo ""
echo "===== ASSISTANT REPLY ====="
echo "$reply"
echo "==========================="
echo ""
trap_msg "PASS — end-to-end loop verified."
