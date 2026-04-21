import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

function parseIds(raw: string): Set<number> {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n)) throw new Error(`Invalid Telegram user ID: ${s}`);
      return n;
    });
  if (ids.length === 0) throw new Error(`TELEGRAM_ALLOWED_USER_IDS must contain at least one ID`);
  return new Set(ids);
}

export const config = {
  // Optional: when unset, the SDK falls back to the Claude Code CLI login
  // credentials (Max/Pro subscription). Run `claude login` on the host.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || null,
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  allowedUserIds: parseIds(required("TELEGRAM_ALLOWED_USER_IDS")),
  githubToken: required("GITHUB_TOKEN"),
  workspaceDir: optional("WORKSPACE_DIR", "/home/claude/workspace"),
  stateDbPath: optional("STATE_DB_PATH", "/var/lib/claude-bot/state.db"),
  dailyCostCapUsd: Number(optional("DAILY_COST_CAP_USD", "5")),
  mcpConfigPath: process.env.MCP_CONFIG_PATH?.trim() || null,
  defaultModel: optional("DEFAULT_MODEL", "claude-opus-4-7"),
} as const;

if (!Number.isFinite(config.dailyCostCapUsd) || config.dailyCostCapUsd < 0) {
  throw new Error(`DAILY_COST_CAP_USD must be a non-negative number`);
}
