#!/usr/bin/env bash
# One-time host bootstrap for claude-bot. Run as root on a fresh Ubuntu 24.04.
# Idempotent — safe to re-run.

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (use sudo)." >&2
  exit 1
fi

echo "== Installing packages =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y git build-essential sqlite3

# GitHub CLI — agent uses `gh` via Bash to interact with GitHub (PRs, issues, releases).
if ! command -v gh >/dev/null 2>&1; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg status=none
  chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update
  apt-get install -y gh
fi

echo "== Installing Claude Code CLI (for OAuth auth) =="
if ! command -v claude >/dev/null 2>&1; then
  npm install -g @anthropic-ai/claude-code
fi

echo "== Installing Playwright system deps (for the Playwright MCP) =="
# Pulls in libnss3, libatk, libcups2, fonts, etc. — needed for headless Chromium.
npx --yes playwright@latest install-deps chromium

echo "== Creating claude user =="
if ! id -u claude >/dev/null 2>&1; then
  useradd -m -s /bin/bash claude
fi

echo "== Installing Chromium browser as claude user =="
# Use -H (set HOME) and cd to claude's home — otherwise npx inherits /root as cwd
# and fails with EACCES when spawning its shell.
sudo -H -u claude bash -c 'cd ~ && npx --yes playwright@latest install chromium'

echo "== Creating directories =="
install -d -o claude -g claude -m 0700 /home/claude/workspace
install -d -o claude -g claude -m 0755 /var/lib/claude-bot

echo "== Configuring git for claude user =="
sudo -u claude git config --global user.name "Claude (Jack's bot)"
sudo -u claude git config --global user.email "jhomer191@gmail.com"
sudo -u claude git config --global init.defaultBranch main
sudo -u claude git config --global --replace-all credential.helper ""

echo "== Creating /etc/claude-bot.env if missing =="
if [ ! -f /etc/claude-bot.env ]; then
  touch /etc/claude-bot.env
fi
# Root-owned, root-only-readable. systemd reads it as root before dropping to
# the 'claude' user, so the bot still gets the env vars — but the agent can't
# `cat` the file itself, blocking prompt-injection-to-exfiltrate attacks.
chown root:root /etc/claude-bot.env
chmod 600 /etc/claude-bot.env

echo "== Done =="
echo "Next steps:"
echo "  1. Clone the bot repo to /opt/claude-bot (owned by a deploy user, not 'claude')"
echo "  2. cd /opt/claude-bot && npm ci && npm run build"
echo "  3. sudo chown -R claude:claude /opt/claude-bot"
echo "  4. Fill in /etc/claude-bot.env"
echo "  5. sudo cp systemd/claude-bot.service /etc/systemd/system/"
echo "  6. sudo systemctl daemon-reload && sudo systemctl enable --now claude-bot"
echo "  7. sudo journalctl -u claude-bot -f    # watch logs"
