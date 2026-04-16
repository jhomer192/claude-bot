import { query, type Query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";

export interface TurnInput {
  prompt: string;
  sessionId: string | null;
  cwd: string;
  mcpServers?: Options["mcpServers"];
}

export function startTurn({ prompt, sessionId, cwd, mcpServers }: TurnInput): Query {
  const options: Options = {
    cwd,
    permissionMode: "bypassPermissions",
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["project"],
    maxTurns: 10000,
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
