/**
 * Tmux-driven Claude agent — the workaround for the June 2026 `-p` quota
 * split. We spawn `claude` interactively inside a per-chat tmux session so
 * usage bills against Max (interactive mode classification) instead of the
 * separate `-p` bucket. Turn completion is signalled by a Stop hook that
 * writes the transcript path to a known dir; we tail the JSONL transcript
 * to get the same structured event stream the SDK normally provides.
 *
 * `startTmuxTurn` returns a `TurnHandle` that duck-types as the SDK's
 * `Query` (async iterator over messages + `interrupt()`), so the consumer
 * in `telegram.ts:runTurn` doesn't care which mode it's in.
 *
 * See docs/p-apocalypse-runbook.md for the broader plan and rationale.
 */
import { exec as execCb } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const exec = promisify(execCb);

// Long ceiling — telegram.ts has its own TURN_IDLE_TIMEOUT (8 min) and
// STALE_STATE watchdog (12h). This is a backstop in case the hook never
// fires (e.g. claude crashed inside the tmux session).
const SIGNAL_TIMEOUT_MS = 30 * 60 * 1000;

// Stop hook fires before the transcript flush completes. Retry the read
// until the terminal `stop_hook_summary` marker is present.
const FLUSH_WAIT_MS = 3000;

// Wait after spawning claude before the first send-keys, so the TUI has
// initialized its input box. Verified empirically in scripts/poc-tmux-claude.sh.
const TUI_WARMUP_MS = 2500;

// Loose mirror of the SDK's message union. We only emit the shapes that
// `telegram.ts:runTurn` actually consumes (system/init, assistant, result).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlock = { type: string } & Record<string, any>;

export type SDKLikeMessage =
  | { type: "system"; subtype: "init"; session_id: string }
  | { type: "assistant"; message: { content: AnyBlock[] } }
  // The SDK emits these for tool_result echoes; the consumer skips them.
  // Tmux mode never emits this variant but the type union must include it
  // so the shared consumer code in `telegram.ts:runTurn` type-checks.
  | { type: "user"; message: unknown }
  | {
      type: "result";
      subtype: "success" | "error";
      total_cost_usd: number;
      usage: Record<string, number>;
      num_turns: number;
      duration_ms: number;
    };

/**
 * Common interface that both the SDK `Query` and our tmux handle satisfy.
 * `telegram.ts:runTurn` consumes it without caring which mode is active.
 */
export interface TurnHandle {
  [Symbol.asyncIterator](): AsyncIterator<SDKLikeMessage>;
  interrupt(): Promise<void>;
}

export interface TmuxTurnInput {
  prompt: string;
  sessionId: string | null; // claude session uuid to resume; null = new
  cwd: string;
  model: string;
  chatId: string;
  signalDir: string;
  settingsPath: string; // settings.json containing the Stop hook
}

function shquote(s: string): string {
  // Wrap in single quotes; escape embedded quotes by closing+escaping+reopening.
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Telegram chat IDs can be negative (groups). Strip the sign for tmux names. */
export function tmuxSessionName(chatId: string): string {
  return `claude-bot-${chatId.replace(/^-/, "neg")}`;
}

async function tmuxSessionExists(name: string): Promise<boolean> {
  try {
    await exec(`tmux has-session -t ${shquote(name)} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist `hasTrustDialogAccepted` for the cwd so the interactive trust
 * dialog doesn't intercept our first send-keys. Idempotent — fast no-op
 * once the project is already trusted.
 */
async function preTrustCwd(cwd: string): Promise<void> {
  const path = join(homedir(), ".claude.json");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: Record<string, any> = {};
  if (existsSync(path)) {
    try {
      data = JSON.parse(await readFile(path, "utf8"));
    } catch {
      data = {};
    }
  }
  data.projects ??= {};
  const entry = (data.projects[cwd] ??= {});
  if (entry.hasTrustDialogAccepted && (entry.projectOnboardingSeenCount ?? 0) >= 99) {
    return;
  }
  entry.hasTrustDialogAccepted = true;
  entry.projectOnboardingSeenCount = Math.max(entry.projectOnboardingSeenCount ?? 0, 99);
  const tmp = `${path}.tmp.${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

async function spawnClaudeInTmux(
  tmuxName: string,
  input: TmuxTurnInput,
  newSessionUuid: string,
): Promise<void> {
  await preTrustCwd(input.cwd);
  const sessionFlag = input.sessionId
    ? `--resume ${shquote(input.sessionId)}`
    : `--session-id ${shquote(newSessionUuid)}`;
  const modelFlag = input.model ? `--model ${shquote(input.model)}` : "";
  const claudeCmd = `claude --settings ${shquote(input.settingsPath)} ${sessionFlag} ${modelFlag}`;
  const tmuxCmd = [
    "tmux", "new-session", "-d",
    "-s", shquote(tmuxName),
    "-e", `CLAUDE_BOT_SIGNAL_DIR=${input.signalDir}`,
    "-c", shquote(input.cwd),
    shquote(claudeCmd),
  ].join(" ");
  await exec(tmuxCmd);
}

async function sendPrompt(tmuxName: string, prompt: string): Promise<void> {
  // `-l` = literal: no key translation (so a colon doesn't open command mode).
  await exec(`tmux send-keys -t ${shquote(tmuxName)} -l ${shquote(prompt)}`);
  await exec(`tmux send-keys -t ${shquote(tmuxName)} Enter`);
}

async function waitForSignal(signalPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(signalPath)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`tmux-agent: Stop signal not received within ${timeoutMs}ms`);
}

async function readTranscriptWhenFlushed(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let content = "";
  while (Date.now() < deadline) {
    try {
      content = await readFile(path, "utf8");
      // stop_hook_summary is the terminal marker — guarantees the assistant
      // block(s) ahead of it are fully written.
      if (content.includes('"subtype":"stop_hook_summary"')) {
        return content;
      }
    } catch {
      // file not flushed yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return content; // best-effort — caller still parses whatever is there
}

/**
 * Drive one turn through a per-chat tmux session. Returns a handle that
 * mirrors the SDK's `Query` shape closely enough for `telegram.ts:runTurn`.
 */
export function startTmuxTurn(input: TmuxTurnInput): TurnHandle {
  const tmuxName = tmuxSessionName(input.chatId);
  const sessionUuid = input.sessionId ?? randomUUID();
  const signalPath = join(input.signalDir, sessionUuid);
  // Track each assistant line we've already emitted so a re-read on a
  // long-running session within one process doesn't double-emit. (For the
  // first turn this is empty; for resume turns the offset starts where the
  // last turn left off.)
  let interrupted = false;
  let turnStartedAt = 0;

  async function* generate(): AsyncIterableIterator<SDKLikeMessage> {
    // Clear any stale signal from a previous turn for this session.
    try {
      await unlink(signalPath);
    } catch {
      // not present
    }

    const existed = await tmuxSessionExists(tmuxName);
    if (!existed) {
      await spawnClaudeInTmux(tmuxName, input, sessionUuid);
      await new Promise((r) => setTimeout(r, TUI_WARMUP_MS));
    }

    // Emit init right away so the consumer can persist the session id.
    yield { type: "system", subtype: "init", session_id: sessionUuid };

    turnStartedAt = Date.now();
    await sendPrompt(tmuxName, input.prompt);

    try {
      await waitForSignal(signalPath, SIGNAL_TIMEOUT_MS);
    } catch (err) {
      if (interrupted) {
        yield {
          type: "result",
          subtype: "error",
          total_cost_usd: 0,
          usage: {},
          num_turns: 0,
          duration_ms: Date.now() - turnStartedAt,
        };
        return;
      }
      throw err;
    }

    if (interrupted) {
      yield {
        type: "result",
        subtype: "error",
        total_cost_usd: 0,
        usage: {},
        num_turns: 0,
        duration_ms: Date.now() - turnStartedAt,
      };
      return;
    }

    const transcriptPath = (await readFile(signalPath, "utf8")).trim();
    const raw = await readTranscriptWhenFlushed(transcriptPath, FLUSH_WAIT_MS);

    // Slice this turn's events using the stop_hook_summary marker — every
    // turn ends with exactly one system/stop_hook_summary event. Walk
    // backward to find the LAST one (this turn's terminator), then back to
    // the prior one (or start of file) and yield everything between.
    // Prompt-text matching is fragile: if Jack sends the same prompt twice
    // (e.g. "/help" repeatedly) we'd misidentify the boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parseLine = (s: string): any => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    };
    const lines = raw.split("\n").filter((l) => l.trim());
    const stopIdxs: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const ev = parseLine(lines[i]!);
      if (ev?.type === "system" && ev?.subtype === "stop_hook_summary") {
        stopIdxs.push(i);
      }
    }
    const turnEnd = stopIdxs.length > 0 ? stopIdxs[stopIdxs.length - 1]! : lines.length;
    const turnStart = stopIdxs.length >= 2 ? stopIdxs[stopIdxs.length - 2]! + 1 : 0;
    const slice = lines.slice(turnStart, turnEnd);

    // Sum usage across all assistant events in this turn. Multi-tool-call
    // turns produce multiple assistant blocks; per-event usage is the
    // increment for that block, not a running total.
    const usage: Record<string, number> = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    let numTurns = 0;

    for (const line of slice) {
      const ev = parseLine(line);
      if (!ev) continue;
      if (ev.type === "assistant" && ev.message?.content) {
        yield { type: "assistant", message: { content: ev.message.content } };
        if (ev.message.usage) {
          usage.input_tokens! += ev.message.usage.input_tokens ?? 0;
          usage.output_tokens! += ev.message.usage.output_tokens ?? 0;
          usage.cache_creation_input_tokens! += ev.message.usage.cache_creation_input_tokens ?? 0;
          usage.cache_read_input_tokens! += ev.message.usage.cache_read_input_tokens ?? 0;
        }
        numTurns += 1;
      }
    }

    yield {
      type: "result",
      subtype: "success",
      // Max billing — usage does not draw from the per-token wallet.
      total_cost_usd: 0,
      usage,
      num_turns: numTurns,
      duration_ms: Date.now() - turnStartedAt,
    };
  }

  const iter = generate();

  return {
    [Symbol.asyncIterator]() {
      return iter;
    },
    async interrupt(): Promise<void> {
      interrupted = true;
      // Escape is the canonical Claude Code interrupt key.
      try {
        await exec(`tmux send-keys -t ${shquote(tmuxName)} Escape`);
      } catch {
        // tmux session may be dead already
      }
    },
  };
}

/**
 * Default settings.json path containing the Stop hook (written by
 * scripts/setup-tmux-mode.sh). Used by `claude --settings`.
 */
export function defaultSettingsPath(override: string | null): string {
  return override ?? join(homedir(), ".claude", "settings.json");
}
