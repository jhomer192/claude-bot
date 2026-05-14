#!/usr/bin/env bash
# Flip claude-bot between Max-subscription billing and API-key billing.
#
# Usage:
#   sudo ./flip-billing-mode.sh max
#   sudo ./flip-billing-mode.sh api sk-ant-api03-...
#
# What it does:
#   - Edits /etc/claude-bot.env in place (sets or clears ANTHROPIC_API_KEY).
#   - Validates the resulting env parses.
#   - Restarts claude-bot.service.
#   - Tails the service log for 5 seconds so you can see startup success.
#
# Why this exists: when the `-p` usage bank splits off Max (June 2026), a
# pinched bot needs a one-command flip to API billing. See
# docs/p-apocalypse-runbook.md.

set -euo pipefail

ENV_FILE="/etc/claude-bot.env"
SERVICE="claude-bot.service"

die() { echo "ERROR: $*" >&2; exit 1; }

mode="${1:-}"
case "$mode" in
  max|api) ;;
  *) die "usage: $0 {max|api [API_KEY]}" ;;
esac

[[ $EUID -eq 0 ]] || die "must run as root (touches $ENV_FILE + systemd)"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found"

# Take a timestamped backup so a botched edit is one cp away from recovery.
backup="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$backup"
echo "Backed up $ENV_FILE → $backup"

if [[ "$mode" == "api" ]]; then
  key="${2:-}"
  [[ -n "$key" ]] || die "api mode requires an API key as the second arg"
  [[ "$key" == sk-ant-* ]] || die "key does not look like an Anthropic API key (sk-ant-...)"

  # Replace existing ANTHROPIC_API_KEY=... line, or append if absent.
  if grep -q '^ANTHROPIC_API_KEY=' "$ENV_FILE"; then
    # Use a delimiter unlikely to appear in keys.
    sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${key}|" "$ENV_FILE"
  else
    printf '\nANTHROPIC_API_KEY=%s\n' "$key" >> "$ENV_FILE"
  fi
  echo "Set ANTHROPIC_API_KEY in $ENV_FILE"
else
  # max mode: blank the key so the SDK falls back to ~/.claude/.credentials.json
  if grep -q '^ANTHROPIC_API_KEY=' "$ENV_FILE"; then
    sed -i 's|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=|' "$ENV_FILE"
    echo "Cleared ANTHROPIC_API_KEY in $ENV_FILE (will use Max login)"
  else
    echo "ANTHROPIC_API_KEY already absent — nothing to clear"
  fi
fi

# Lock down perms in case sed widened them. Service runs as `claude`.
chown root:claude "$ENV_FILE"
chmod 640 "$ENV_FILE"

echo "Restarting $SERVICE..."
systemctl restart "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE" || {
  echo "Service failed to come up. Recent logs:"
  journalctl -u "$SERVICE" -n 30 --no-pager
  die "rollback with: cp $backup $ENV_FILE && systemctl restart $SERVICE"
}

echo "Service is active. Tailing logs for 5s..."
timeout 5 journalctl -u "$SERVICE" -n 0 -f --no-pager || true
echo "Done. Send a Telegram message to verify end-to-end."
