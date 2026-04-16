import { Bot, GrammyError, HttpError, type Context } from "grammy";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { SessionStore } from "./sessions.js";
import { startTurn, loadMcpServers } from "./agent.js";
import { ensureCloned, isValidSlug, repoPath } from "./workspace.js";

const MAX_MSG = 4096;
const SOFT_CAP = 3800;

// Loose block type — the SDK's real types are a wide discriminated union.
// We narrow at runtime via block.type, so this permissive shape is fine.
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlock = { type: string } & Record<string, any>;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function cleanToolName(name: string): string {
  // Strip the mcp__<server>__ prefix from MCP tool names.
  const m = name.match(/^mcp__([^_]+)__(.+)$/);
  return m ? `${m[1]}: ${m[2]}` : name;
}

function toolEmoji(name: string, input?: unknown): string {
  switch (name) {
    case "Bash": {
      const cmd = (input as { command?: unknown } | undefined)?.command;
      if (typeof cmd === "string" && /^\s*gh(\s|$)/.test(cmd)) return "🐙";
      return "💻";
    }
    case "Read": return "📖";
    case "Write":
    case "Edit": return "✏️";
    case "Glob":
    case "Grep": return "🔎";
    case "WebFetch": return "🌐";
    case "WebSearch": return "🔍";
    case "Task": return "🧙";
    case "TodoWrite": return "📋";
    case "AskUserQuestion": return "❓";
  }
  if (name.startsWith("mcp__playwright__")) return "🎭";
  if (name.startsWith("mcp__github__")) return "🐙";
  if (name.startsWith("mcp__")) return "🔌";
  return "🤖";
}

function previewToolInput(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : "");
  switch (name) {
    case "Bash":
      return pick("command");
    case "Edit":
    case "Write":
    case "Read":
      return pick("file_path");
    case "Glob":
    case "Grep":
      return pick("pattern");
    case "WebFetch":
    case "WebSearch":
      return pick("url") || pick("query");
    case "Task": {
      const agentType = pick("subagent_type");
      const desc = pick("description");
      if (agentType && desc) return `${agentType} — ${desc}`;
      return desc || agentType;
    }
  }
  // MCP tools — show useful field if we know one, otherwise nothing.
  if (name.includes("browser_navigate")) return pick("url");
  if (name.includes("browser_click")) return pick("element") || pick("ref");
  if (name.includes("browser_type") || name.includes("browser_fill")) return pick("text") || pick("element");
  if (name.includes("browser_evaluate")) return (pick("function") || "").slice(0, 80);
  // Unknown tool: no preview (don't dump raw JSON, it's noise).
  return "";
}

/**
 * Accumulates text and flushes to Telegram, editing the active message and
 * spawning a new one once the soft cap is hit. One instance per turn.
 */
class StreamingRenderer {
  private buffer = "";
  private activeMessageId: number;
  private pendingEdit: NodeJS.Timeout | null = null;
  private lastSent = "";

  constructor(
    private readonly bot: Bot,
    private readonly chatId: number,
    initialMessageId: number,
  ) {
    this.activeMessageId = initialMessageId;
  }

  async appendLine(line: string): Promise<void> {
    // Ensure a blank line between each block for breathing room.
    let prefix = "";
    if (this.buffer.length > 0) {
      if (this.buffer.endsWith("\n\n")) prefix = "";
      else if (this.buffer.endsWith("\n")) prefix = "\n";
      else prefix = "\n\n";
    }
    await this.append(prefix + line + "\n");
  }

  async append(text: string): Promise<void> {
    if (!text) return;
    const combined = this.buffer + text;
    if (combined.length > SOFT_CAP) {
      // Freeze current message if it has content, start a new one
      await this.flushEdit();
      if (this.buffer.trim().length > 0) {
        const next = await this.bot.api.sendMessage(this.chatId, truncate(text, MAX_MSG));
        this.activeMessageId = next.message_id;
        this.buffer = text;
        this.lastSent = text;
      } else {
        this.buffer = text;
        this.scheduleEdit();
      }
      return;
    }
    this.buffer = combined;
    this.scheduleEdit();
  }

  async finalize(footer?: string): Promise<void> {
    if (footer) {
      await this.appendLine(footer);
    }
    await this.flushEdit();
    if (this.buffer.trim().length === 0) {
      try {
        await this.bot.api.editMessageText(this.chatId, this.activeMessageId, "(done - no output)");
      } catch {
        // ignore
      }
    }
  }

  private scheduleEdit(): void {
    if (this.pendingEdit) return;
    this.pendingEdit = setTimeout(() => {
      this.pendingEdit = null;
      void this.flushEdit();
    }, 600);
  }

  private async flushEdit(): Promise<void> {
    if (this.pendingEdit) {
      clearTimeout(this.pendingEdit);
      this.pendingEdit = null;
    }
    if (!this.buffer || this.buffer === this.lastSent) return;
    const text = truncate(this.buffer, MAX_MSG);
    try {
      await this.bot.api.editMessageText(this.chatId, this.activeMessageId, text);
      this.lastSent = this.buffer;
    } catch (err) {
      if (err instanceof GrammyError && err.description?.includes("message is not modified")) {
        // harmless race
        return;
      }
      console.error("Telegram edit failed:", err);
    }
  }
}

const HELP_TEXT = [
  "Claude bot — text me code tasks.",
  "",
  "Commands:",
  "/new        — start a fresh session (forgets prior context)",
  "/repo owner/name  — set the repo I'll work in",
  "/stop       — interrupt the current turn",
  "/cost       — show today's spend in this chat",
  "/help       — show this message",
  "",
  "Otherwise, just send a message and I'll work on it.",
].join("\n");

export class TelegramBridge {
  private bot: Bot;
  private active = new Map<string, Query>();

  constructor(private readonly sessions: SessionStore) {
    this.bot = new Bot(config.telegramBotToken);
    this.wire();
  }

  async start(): Promise<void> {
    console.log("Starting Telegram bot (long-polling)…");
    // start() blocks; don't await — it runs until the bot stops
    void this.bot.start({
      onStart: (info) => console.log(`Logged in as @${info.username}`),
    });
  }

  async stop(): Promise<void> {
    for (const q of this.active.values()) {
      try { await q.interrupt(); } catch { /* ignore */ }
    }
    this.active.clear();
    await this.bot.stop();
  }

  private wire(): void {
    // Access gate for every update
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (!userId || !config.allowedUserIds.has(userId)) {
        return; // silently ignore
      }
      await next();
    });

    this.bot.command(["start", "help"], async (ctx) => {
      await ctx.reply(HELP_TEXT);
    });

    this.bot.command("new", async (ctx) => {
      const chatId = String(ctx.chat.id);
      this.sessions.clearSession(chatId);
      await ctx.reply("✓ fresh session. What's up?");
    });

    this.bot.command("stop", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const q = this.active.get(chatId);
      if (q) {
        await q.interrupt();
        await ctx.reply("⏹ stopped");
      } else {
        await ctx.reply("nothing running");
      }
    });

    this.bot.command("cost", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const spent = this.sessions.getDailyCost(chatId);
      await ctx.reply(`today: $${spent.toFixed(4)} / $${config.dailyCostCapUsd.toFixed(2)}`);
    });

    this.bot.command("repo", async (ctx) => {
      const slug = ctx.match.trim();
      if (!slug) {
        const current = this.sessions.getRepo(String(ctx.chat.id));
        await ctx.reply(current ? `repo: ${current}` : "no repo set — usage: /repo owner/name");
        return;
      }
      if (!isValidSlug(slug)) {
        await ctx.reply(`invalid slug "${slug}" — expected owner/name`);
        return;
      }
      const chatId = String(ctx.chat.id);
      this.sessions.setRepo(chatId, slug);
      try {
        await ensureCloned(config.workspaceDir, slug, config.githubToken);
        await ctx.reply(`✓ workspace set to ${slug}`);
      } catch (err) {
        await ctx.reply(`✗ clone failed: ${truncate(String(err), 500)}`);
      }
    });

    this.bot.on("message:text", async (ctx) => {
      if (ctx.message.text.startsWith("/")) return; // command handlers will have caught it
      await this.runTurn(ctx, ctx.message.text);
    });

    this.bot.catch((err) => {
      const ctx = err.ctx;
      console.error(`grammy error in update ${ctx.update.update_id}:`, err.error);
      if (err.error instanceof GrammyError) console.error("API:", err.error.description);
      else if (err.error instanceof HttpError) console.error("HTTP:", err.error);
    });
  }

  private async runTurn(ctx: Context, prompt: string): Promise<void> {
    const chatId = String(ctx.chat!.id);
    const chatIdNum = ctx.chat!.id;

    const dailyCost = this.sessions.getDailyCost(chatId);
    if (dailyCost >= config.dailyCostCapUsd) {
      await ctx.reply(
        `⛔ daily cost cap reached ($${dailyCost.toFixed(2)} / $${config.dailyCostCapUsd}). Try again tomorrow or raise the cap.`,
      );
      return;
    }

    if (this.active.has(chatId)) {
      await ctx.reply("already working — send /stop first");
      return;
    }

    const sessionId = this.sessions.getSessionId(chatId);
    const repo = this.sessions.getRepo(chatId);
    const cwd = repo ? repoPath(config.workspaceDir, repo) : config.workspaceDir;

    if (repo) {
      try {
        await ensureCloned(config.workspaceDir, repo, config.githubToken);
      } catch (err) {
        await ctx.reply(`✗ could not prepare workspace: ${truncate(String(err), 500)}`);
        return;
      }
    }

    const placeholder = await ctx.reply("⏳ working…");
    const renderer = new StreamingRenderer(this.bot, chatIdNum, placeholder.message_id);

    const q = startTurn({
      prompt,
      sessionId,
      cwd,
      mcpServers: loadMcpServers(config.mcpConfigPath),
    });
    this.active.set(chatId, q);

    try {
      for await (const m of q) {
        if (m.type === "system" && m.subtype === "init") {
          this.sessions.saveSessionId(chatId, m.session_id);
          continue;
        }

        if (m.type === "assistant") {
          const blocks = (m.message.content ?? []) as unknown as Array<AnyBlock>;
          for (const block of blocks) {
            if (block.type === "text") {
              await renderer.appendLine(block.text);
            } else if (block.type === "tool_use") {
              const cleanName = cleanToolName(block.name);
              const preview = previewToolInput(block.name, block.input);
              const emoji = toolEmoji(block.name, block.input);
              const emojiPrefix = emoji ? `${emoji} ` : "";
              await renderer.appendLine(`${emojiPrefix}${cleanName}${preview ? `: ${truncate(preview, 120)}` : ""}`);
            }
          }
          continue;
        }

        // Skip tool_result rendering — the assistant's next text block
        // summarizes what happened, and raw tool output is usually progress
        // bars / ANSI noise that Telegram mangles anyway.
        if (m.type === "user") {
          continue;
        }

        if (m.type === "result") {
          const cost = m.total_cost_usd ?? 0;
          this.sessions.addCost(chatId, cost);
          const u = m.usage ?? {};
          const inTok =
            (u.input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0);
          const outTok = u.output_tokens ?? 0;
          const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
          const footer = `${m.num_turns} turns, ${(m.duration_ms / 1000).toFixed(1)}s, ${fmt(inTok)} in / ${fmt(outTok)} out${m.subtype !== "success" ? ` (${m.subtype})` : ""}`;
          await renderer.finalize(footer);
          continue;
        }
      }
    } catch (err) {
      console.error("Turn failed:", err);
      try {
        await ctx.reply(`✗ turn failed: ${truncate(String(err), 500)}`);
      } catch { /* ignore */ }
    } finally {
      this.active.delete(chatId);
    }
  }
}
