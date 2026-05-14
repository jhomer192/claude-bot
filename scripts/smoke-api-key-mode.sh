#!/usr/bin/env bash
# Smoke-test Path A (API-key billing) without disturbing the running bot.
#
# Usage:
#   ./smoke-api-key-mode.sh sk-ant-api03-...
#
# Confirms:
#   1. The key authenticates against the Anthropic Messages API.
#   2. The configured DEFAULT_MODEL is accessible from that key.
#   3. A round-trip completes in <30s.
#
# Why not run a full SDK turn? That would need a throwaway workspace,
# Telegram mocks, and SQLite state. The SDK ultimately calls the same
# Messages endpoint we curl here, so a 200 response is sufficient signal
# that the flip will work. Run this quarterly and before the June bank cut.

set -euo pipefail

key="${1:-}"
if [[ -z "$key" ]]; then
  echo "usage: $0 sk-ant-api03-..." >&2
  exit 2
fi

# Match the bot's DEFAULT_MODEL fallback in src/config.ts.
model="${DEFAULT_MODEL:-claude-opus-4-7}"

echo "Smoke test: model=$model key=${key:0:14}…"

response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT

http_code=$(curl -sS -o "$response_file" -w "%{http_code}" \
  --max-time 30 \
  https://api.anthropic.com/v1/messages \
  -H "x-api-key: $key" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "$(cat <<JSON
{
  "model": "$model",
  "max_tokens": 32,
  "messages": [{"role": "user", "content": "Reply with the single word: OK"}]
}
JSON
)")

if [[ "$http_code" != "200" ]]; then
  echo "FAIL: HTTP $http_code" >&2
  echo "Response:" >&2
  cat "$response_file" >&2
  exit 1
fi

# Extract the text body to confirm we got a real model response (not a
# weird success-with-empty-body).
text=$(python3 -c "import json,sys; d=json.load(open('$response_file')); print(d['content'][0]['text'])" 2>/dev/null || echo "")
if [[ -z "$text" ]]; then
  echo "FAIL: 200 but no content[0].text in response" >&2
  cat "$response_file" >&2
  exit 1
fi

echo "PASS: model replied with: $text"
echo "Path A is ready. To flip prod:  sudo ./flip-billing-mode.sh api $key"
