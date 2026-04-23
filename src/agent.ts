import {
  query,
  type Query,
  type Options,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const require_ = createRequire(import.meta.url);
// SDK's package.json exports map doesn't expose cli.js, so resolve the main
// entry (sdk.mjs) and take its sibling.
const CLAUDE_CODE_CLI_PATH = join(
  dirname(require_.resolve("@anthropic-ai/claude-agent-sdk")),
  "cli.js",
);

export interface TurnInput {
  prompt: string;
  sessionId: string | null;
  cwd: string;
  model: string;
  mcpServers?: Options["mcpServers"];
}

// The SDK defaults to spawning the literal string "node", relying on PATH
// lookup inside the systemd sandbox. We've hit `spawn node EACCES` here, so
// use the parent's execPath directly and surface the child's stderr plus
// errno/syscall/path on spawn failure.
// Secrets the parent process needs but the agent subprocess never should.
// Stripping them prevents the agent from exfiltrating them via printenv/Bash.
const SUBPROCESS_REDACTED_ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "GITHUB_TOKEN",
];

function spawnClaudeCodeProcess({
  command,
  args,
  cwd,
  env,
  signal,
}: SpawnOptions): SpawnedProcess {
  const resolved = command === "node" ? process.execPath : command;

  // Remove secrets the agent has no legitimate use for.
  const safeEnv = { ...env } as Record<string, string | undefined>;
  for (const key of SUBPROCESS_REDACTED_ENV_KEYS) {
    delete safeEnv[key];
  }

  const child = spawn(resolved, args, {
    cwd,
    env: safeEnv,
    stdio: ["pipe", "pipe", "pipe"],
    signal,
    windowsHide: true,
  });
  child.on("error", (err: NodeJS.ErrnoException) => {
    console.error(
      `[spawn] failed cmd=${resolved} errno=${err.code ?? "-"} syscall=${err.syscall ?? "-"} path=${err.path ?? "-"} PATH=${env.PATH ?? "-"}`,
    );
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[claude-cli] ${chunk}`);
  });
  return child as unknown as SpawnedProcess;
}

export function startTurn({ prompt, sessionId, cwd, model, mcpServers }: TurnInput): Query {
  const options: Options = {
    cwd,
    model,
    permissionMode: "bypassPermissions",
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: [],
    maxTurns: 10000,
    // Every Telegram message is already the answer — a structured follow-up
    // tool leaves an orphan tool_use that poisons the session on resume.
    disallowedTools: ["AskUserQuestion"],
    pathToClaudeCodeExecutable: CLAUDE_CODE_CLI_PATH,
    spawnClaudeCodeProcess,
    ...(sessionId ? { resume: sessionId } : {}),
    ...(mcpServers ? { mcpServers } : {}),
  };

  return query({ prompt, options });
}

export function loadMcpServers(path: string | null): Options["mcpServers"] | undefined {
  if (!path) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return parsed as Options["mcpServers"];
  } catch (err) {
    console.error(`Failed to load MCP config at ${path}:`, err);
    return undefined;
  }
}
