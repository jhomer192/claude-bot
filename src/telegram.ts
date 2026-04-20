import { Bot, GrammyError, HttpError, type Context } from "grammy";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { SessionStore } from "./sessions.js";
import { startTurn, loadMcpServers } from "./agent.js";
import { ensureCloned, isValidSlug, repoPath } from "./workspace.js";

const MAX_MSG = 4096;
const SOFT_CAP = 3800;
const EDIT_WINDOW_MS = 3000;

// Loose block type — the SDK's real types are a wide discriminated union.
// We narrow at runtime via block.type, so this permissive shape is fine.
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlock = { type: string } & Record<string, any>;

// n is the maximum length of the returned string, including the ellipsis.
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Split text into pieces no longer than cap, preferring to break on newlines.
function splitForTelegram(text: string, cap: number = MAX_MSG): string[] {
  if (text.length <= cap) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > cap) {
    let cut = rest.lastIndexOf("\n", cap);
    if (cut <= 0) cut = cap;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) out.push(rest);
  return out;
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
    if (combined.length <= SOFT_CAP) {
      this.buffer = combined;
      this.scheduleEdit();
      return;
    }
    // Freeze current message (if it has content), then start one or more new
    // messages to hold the overflow. A single append may be larger than one
    // Telegram message can hold, so we split on newlines where possible.
    await this.flushEdit();
    const hadContent = this.buffer.trim().length > 0;
    const pieces = splitForTelegram(text, SOFT_CAP);
    if (!hadContent) {
      // Current message is empty (just the placeholder). Edit it with the first
      // piece instead of sending a new one.
      this.buffer = pieces[0]!;
      await this.flushEdit();
      for (const piece of pieces.slice(1)) {
        const next = await this.bot.api.sendMessage(this.chatId, piece);
        this.activeMessageId = next.message_id;
        this.buffer = piece;
        this.lastSent = piece;
      }
      return;
    }
    for (const piece of pieces) {
      const next = await this.bot.api.sendMessage(this.chatId, piece);
      this.activeMessageId = next.message_id;
      this.buffer = piece;
      this.lastSent = piece;
    }
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
  "/stop       — interrupt the current turn (queued messages keep going)",
  "/drain      — cancel everything still in the queue",
  "/cost       — show today's spend in this chat",
  "/help       — show this message",
  "",
  "Otherwise, just send a message and I'll work on it.",
].join("\n");

interface PendingTurn {
  chatId: number;
  userMessageId: number;
  text: string;
  placeholderId: number;
}

export class TelegramBridge {
  private bot: Bot;
  private active = new Map<string, Query>();
  private queue = new Map<string, PendingTurn[]>();
  private readyTimer = new Map<string, NodeJS.Timeout>();

  constructor(private readonly sessions: SessionStore) {
    this.bot = new Bot(config.telegramBotToken);
    this.wire();
  }

  async start(): Promise<void> {
    console.log("Starting Telegram bot (long-polling)…");
    // start() blocks; don't await — it runs until the bot stops
    void this.bot.start({
      allowed_updates: ["message", "edited_message"],
      onStart: (info) => console.log(`Logged in as @${info.username}`),
    });
  }

  async stop(): Promise<void> {
    for (const t of this.readyTimer.values()) clearTimeout(t);
    this.readyTimer.clear();
    this.queue.clear();
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
        // The next queued message (if any) will auto-start via advanceQueue.
        await q.interrupt();
        await ctx.reply("⏹ stopped");
        return;
      }
      // Nothing running — cancel the front of the queue if it's about to fire.
      const front = this.dequeueFront(chatId);
      if (front) {
        try {
          await this.bot.api.editMessageText(ctx.chat.id, front.placeholderId, "⏹ cancelled");
        } catch { /* ignore */ }
        this.advanceQueue(chatId);
        return;
      }
      await ctx.reply("nothing running");
    });

    this.bot.command("drain", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const items = this.queue.get(chatId) ?? [];
      const timer = this.readyTimer.get(chatId);
      if (timer) {
        clearTimeout(timer);
        this.readyTimer.delete(chatId);
      }
      this.queue.delete(chatId);
      for (const item of items) {
        try {
          await this.bot.api.editMessageText(ctx.chat.id, item.placeholderId, "⏹ cancelled");
        } catch { /* ignore */ }
      }
      await ctx.reply(`⏹ drained ${items.length} queued message${items.length === 1 ? "" : "s"}`);
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
      await this.enqueueTurn(ctx, ctx.message.message_id, ctx.message.text);
    });

    this.bot.on("edited_message:text", async (ctx) => {
      await this.handleEdit(ctx);
    });

    this.bot.catch((err) => {
      const ctx = err.ctx;
      console.error(`grammy error in update ${ctx.update.update_id}:`, err.error);
      if (err.error instanceof GrammyError) console.error("API:", err.error.description);
      else if (err.error instanceof HttpError) console.error("HTTP:", err.error);
    });
  }

  private async enqueueTurn(ctx: Context, userMessageId: number, text: string): Promise<void> {
    const chatIdNum = ctx.chat!.id;
    const chatId = String(chatIdNum);

    const dailyCost = this.sessions.getDailyCost(chatId);
    if (dailyCost >= config.dailyCostCapUsd) {
      await ctx.reply(
        `⛔ daily cost cap reached ($${dailyCost.toFixed(2)} / $${config.dailyCostCapUsd}). Try again tomorrow or raise the cap.`,
      );
      return;
    }

    const items = this.queue.get(chatId) ?? [];
    const positionBehind = items.length + (this.active.has(chatId) ? 1 : 0);
    const label = positionBehind === 0
      ? `⏳ queued (${EDIT_WINDOW_MS / 1000}s to edit)`
      : `⏳ queued (#${positionBehind + 1} in line — edit anytime before it starts)`;
    const placeholder = await ctx.reply(label);

    items.push({
      chatId: chatIdNum,
      userMessageId,
      text,
      placeholderId: placeholder.message_id,
    });
    this.queue.set(chatId, items);

    this.maybeArmReady(chatId);
  }

  private async handleEdit(ctx: Context): Promise<void> {
    const chatIdNum = ctx.chat!.id;
    const chatId = String(chatIdNum);
    const edited = ctx.editedMessage!;
    const items = this.queue.get(chatId) ?? [];
    const idx = items.findIndex((p) => p.userMessageId === edited.message_id);
    if (idx < 0) {
      // Either already processing or never queued.
      if (this.active.has(chatId)) {
        await ctx.reply("can't edit mid-turn — /stop first");
      }
      return;
    }
    const item = items[idx]!;
    item.text = edited.text ?? item.text;
    const isFront = idx === 0 && !this.active.has(chatId);
    if (isFront) {
      // Reset debounce so the user gets a fresh window after the edit lands.
      const timer = this.readyTimer.get(chatId);
      if (timer) clearTimeout(timer);
      this.readyTimer.delete(chatId);
      this.maybeArmReady(chatId);
    }
    const label = isFront
      ? `⏳ queued — edit received (${EDIT_WINDOW_MS / 1000}s to edit again)`
      : `⏳ queued — edit received (#${idx + 1 + (this.active.has(chatId) ? 1 : 0)} in line)`;
    try {
      await this.bot.api.editMessageText(chatIdNum, item.placeholderId, label);
    } catch { /* ignore */ }
  }

  private maybeArmReady(chatId: string): void {
    if (this.active.has(chatId)) return;
    if (this.readyTimer.has(chatId)) return;
    const items = this.queue.get(chatId);
    if (!items || items.length === 0) return;
    const timer = setTimeout(() => {
      this.readyTimer.delete(chatId);
      const front = this.dequeueFront(chatId);
      if (!front) return;
      void this.runTurn(front.chatId, front.text, front.placeholderId);
    }, EDIT_WINDOW_MS);
    this.readyTimer.set(chatId, timer);
  }

  private dequeueFront(chatId: string): PendingTurn | undefined {
    const timer = this.readyTimer.get(chatId);
    if (timer) {
      clearTimeout(timer);
      this.readyTimer.delete(chatId);
    }
    const items = this.queue.get(chatId);
    if (!items || items.length === 0) return undefined;
    const front = items.shift();
    if (items.length === 0) this.queue.delete(chatId);
    return front;
  }

  private advanceQueue(chatId: string): void {
    const items = this.queue.get(chatId);
    if (!items || items.length === 0) return;
    // New front — update its placeholder to show it's about to fire, then arm.
    const front = items[0]!;
    void this.bot.api
      .editMessageText(front.chatId, front.placeholderId, `⏳ queued (${EDIT_WINDOW_MS / 1000}s to edit)`)
      .catch(() => {});
    this.maybeArmReady(chatId);
  }

  private async runTurn(chatIdNum: number, prompt: string, placeholderId: number): Promise<void> {
    const chatId = String(chatIdNum);

    // Re-check the cost cap: earlier items in the queue may have pushed us over
    // since this one was accepted.
    const dailyCost = this.sessions.getDailyCost(chatId);
    if (dailyCost >= config.dailyCostCapUsd) {
      try {
        await this.bot.api.editMessageText(
          chatIdNum,
          placeholderId,
          `⛔ daily cost cap reached ($${dailyCost.toFixed(2)} / $${config.dailyCostCapUsd})`,
        );
      } catch { /* ignore */ }
      this.advanceQueue(chatId);
      return;
    }

    const sessionId = this.sessions.getSessionId(chatId);
    const repo = this.sessions.getRepo(chatId);
    const cwd = repo ? repoPath(config.workspaceDir, repo) : config.workspaceDir;

    if (repo) {
      try {
        await ensureCloned(config.workspaceDir, repo, config.githubToken);
      } catch (err) {
        try {
          await this.bot.api.editMessageText(
            chatIdNum,
            placeholderId,
            `✗ could not prepare workspace: ${truncate(String(err), 500)}`,
          );
        } catch { /* ignore */ }
        this.advanceQueue(chatId);
        return;
      }
    }

    try {
      await this.bot.api.editMessageText(chatIdNum, placeholderId, "⏳ working…");
    } catch { /* ignore */ }
    const renderer = new StreamingRenderer(this.bot, chatIdNum, placeholderId);

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
        await this.bot.api.sendMessage(chatIdNum, `✗ turn failed: ${truncate(String(err), 500)}`);
      } catch { /* ignore */ }
    } finally {
      this.active.delete(chatId);
      this.advanceQueue(chatId);
    }
  }
}
