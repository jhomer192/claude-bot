import { Bot, GrammyError, HttpError, type Context } from "grammy";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { SessionStore } from "./sessions.js";
import { startTurn, loadMcpServers } from "./agent.js";
import { ensureCloned, isValidSlug, repoPath } from "./workspace.js";

const MAX_MSG = 4096;
const SOFT_CAP = 3800;
const EDIT_WINDOW_MS = 3000;
// If the SDK emits nothing for this long, the turn is wedged (e.g. a Bash
// call blocked on a never-exiting process). Abort and unblock the chat.
const TURN_IDLE_TIMEOUT_MS = 8 * 60 * 1000;
// Absolute wall-clock cap per turn. Catches actively-looping turns that
// never go idle but spin forever (e.g. re-editing the same file chasing
// a phantom bug). Bounds cost/usage blast radius.
const TURN_MAX_DURATION_MS = 60 * 60 * 1000;
// q.interrupt() can hang forever when the SDK subprocess is wedged.
// Cap it so /stop always returns to the user.
const INTERRUPT_TIMEOUT_MS = 2000;
// Last-ditch safety net: if any turn has been active or any queue item has
// been sitting for longer than this, exit the process so systemd restarts
// the service and clears all in-memory state.
const STALE_STATE_LIMIT_MS = 60 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

const IDLE_TIMEOUT_MARKER = "__claude_bot_idle_timeout__";

// Returns true if interrupt() completed (success or SDK-side error).
// Returns false if it hung past the timeout — in that case the SDK subprocess
// is likely wedged and the caller should force-clear its own state.
async function interruptWithTimeout(q: Query): Promise<boolean> {
  const HUNG = Symbol("hung");
  const result = await Promise.race([
    q.interrupt().then(() => true, () => true),
    new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), INTERRUPT_TIMEOUT_MS)),
  ]);
  return result !== HUNG;
}

// Short aliases → full model IDs. Raw `claude-*` IDs are also accepted.
const MODEL_ALIASES: Record<string, string> = {
  "opus": "claude-opus-4-7",
  "opus-4.7": "claude-opus-4-7",
  "4.7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6",
  "4.6": "claude-opus-4-6",
  "sonnet": "claude-sonnet-4-6",
  "sonnet-4.6": "claude-sonnet-4-6",
  "haiku": "claude-haiku-4-5-20251001",
  "haiku-4.5": "claude-haiku-4-5-20251001",
};

function resolveModel(input: string): string | null {
  const key = input.trim().toLowerCase();
  if (!key) return null;
  if (MODEL_ALIASES[key]) return MODEL_ALIASES[key];
  if (/^claude-[a-z0-9-]+$/.test(key)) return key;
  return null;
}

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
  "/model <name>  — set the model (opus, sonnet, haiku, 4.6, …); no arg to show current",
  "/stop       — interrupt the current turn (queued messages keep going)",
  "/drain      — cancel everything still in the queue",
  "/restart    — hard-restart the bot process (use if the bot is wedged)",
  "/cost       — show today's spend in this chat",
  "/usage      — show last Anthropic-limit event (if any) and current model",
  "/help       — show this message",
  "",
  "Otherwise, just send a message and I'll work on it.",
].join("\n");

interface PendingTurn {
  chatId: number;
  userMessageId: number;
  text: string;
  placeholderId: number;
  enqueuedAt: number;
}

export class TelegramBridge {
  private bot: Bot;
  private active = new Map<string, Query>();
  private activeStartedAt = new Map<string, number>();
  private queue = new Map<string, PendingTurn[]>();
  private readyTimer = new Map<string, NodeJS.Timeout>();
  private watchdog: NodeJS.Timeout | null = null;
  private lastLimitEvent: { message: string; at: number } | null = null;

  constructor(private readonly sessions: SessionStore) {
    this.bot = new Bot(config.telegramBotToken);
    this.wire();
  }

  async start(): Promise<void> {
    console.log("Starting Telegram bot (long-polling)…");
    this.watchdog = setInterval(() => this.checkStaleState(), WATCHDOG_INTERVAL_MS);
    // start() blocks; don't await — it runs until the bot stops
    void this.bot.start({
      allowed_updates: ["message", "edited_message"],
      onStart: (info) => console.log(`Logged in as @${info.username}`),
    });
  }

  async stop(): Promise<void> {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    for (const t of this.readyTimer.values()) clearTimeout(t);
    this.readyTimer.clear();
    this.queue.clear();
    await Promise.all(
      [...this.active.values()].map((q) => interruptWithTimeout(q)),
    );
    this.active.clear();
    this.activeStartedAt.clear();
    await this.bot.stop();
  }

  // Last-ditch safety net. If anything has been stuck for an hour —
  // an active turn, or a queue item that never moved — exit so systemd
  // restarts us with clean in-memory state.
  private checkStaleState(): void {
    const now = Date.now();
    for (const [chatId, startedAt] of this.activeStartedAt) {
      const ageMs = now - startedAt;
      if (ageMs > STALE_STATE_LIMIT_MS) {
        console.error(
          `WATCHDOG: active turn for chat ${chatId} is ${Math.floor(ageMs / 60000)}min old — exiting for systemd restart`,
        );
        process.exit(1);
      }
    }
    for (const [chatId, items] of this.queue) {
      const head = items[0];
      if (!head) continue;
      const ageMs = now - head.enqueuedAt;
      if (ageMs > STALE_STATE_LIMIT_MS) {
        console.error(
          `WATCHDOG: queue head for chat ${chatId} is ${Math.floor(ageMs / 60000)}min old — exiting for systemd restart`,
        );
        process.exit(1);
      }
    }
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
        const clean = await interruptWithTimeout(q);
        if (clean) {
          // The runTurn finally block will clear active and advance the queue.
          await ctx.reply("⏹ stopped");
        } else {
          // SDK is wedged — interrupt didn't complete. Force-clear so the
          // chat isn't stuck on active.has() forever. The zombie SDK
          // subprocess will leak until the service restarts.
          this.active.delete(chatId);
          this.advanceQueue(chatId);
          await ctx.reply("⏹ force-stopped — SDK unresponsive, state cleared");
        }
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

    this.bot.command("restart", async (ctx) => {
      await ctx.reply("♻ restarting — back in a few seconds");
      // Exit non-zero so systemd's Restart=on-failure kicks in. Give the
      // reply a moment to flush to Telegram before we die.
      setTimeout(() => process.exit(1), 500);
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

    this.bot.command("usage", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const model = this.sessions.getModel(chatId) ?? config.defaultModel;
      const spent = this.sessions.getDailyCost(chatId);
      const lines = [
        `model: ${model}`,
        `today's cost: $${spent.toFixed(4)} / $${config.dailyCostCapUsd.toFixed(2)}`,
      ];
      if (this.lastLimitEvent) {
        const minsAgo = Math.floor((Date.now() - this.lastLimitEvent.at) / 60000);
        lines.push(`last Anthropic limit hit ${minsAgo}m ago: ${this.lastLimitEvent.message}`);
      } else {
        lines.push("no Anthropic limit events since bot started");
      }
      await ctx.reply(lines.join("\n"));
    });

    this.bot.command("model", async (ctx) => {
      const chatId = String(ctx.chat.id);
      const arg = ctx.match.trim();
      if (!arg) {
        const current = this.sessions.getModel(chatId) ?? config.defaultModel;
        await ctx.reply(`model: ${current}`);
        return;
      }
      if (arg === "default" || arg === "reset") {
        this.sessions.setModel(chatId, null);
        await ctx.reply(`✓ model reset to default (${config.defaultModel})`);
        return;
      }
      const resolved = resolveModel(arg);
      if (!resolved) {
        await ctx.reply(`unknown model "${arg}" — try: opus, sonnet, haiku, 4.6, or a full claude-* id`);
        return;
      }
      this.sessions.setModel(chatId, resolved);
      await ctx.reply(`✓ model set to ${resolved}`);
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
      enqueuedAt: Date.now(),
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

    const model = this.sessions.getModel(chatId) ?? config.defaultModel;

    const q = startTurn({
      prompt,
      sessionId,
      cwd,
      model,
      mcpServers: loadMcpServers(config.mcpConfigPath),
    });
    const turnStartedAt = Date.now();
    this.active.set(chatId, q);
    this.activeStartedAt.set(chatId, turnStartedAt);

    try {
      // Drive iteration manually so we can race each step against an idle
      // timeout. If the SDK stops emitting messages for more than
      // TURN_IDLE_TIMEOUT_MS the turn is wedged (e.g. Bash blocked on a
      // never-exiting dev server) and we abort.
      const iter = q[Symbol.asyncIterator]();
      while (true) {
        if (Date.now() - turnStartedAt > TURN_MAX_DURATION_MS) {
          throw new Error(
            `Turn exceeded max duration of ${TURN_MAX_DURATION_MS / 60000} min`,
          );
        }
        const step = await Promise.race([
          iter.next(),
          new Promise<typeof IDLE_TIMEOUT_MARKER>((r) =>
            setTimeout(() => r(IDLE_TIMEOUT_MARKER), TURN_IDLE_TIMEOUT_MS),
          ),
        ]);
        if (step === IDLE_TIMEOUT_MARKER) {
          throw new Error(
            `Turn stalled — no SDK activity for ${TURN_IDLE_TIMEOUT_MS / 60000} min`,
          );
        }
        if (step.done) break;
        const m = step.value;

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
      const msg = String(err);
      // [ede_diagnostic] means the conversation state is broken (usually an
      // orphan tool_use with no matching tool_result). Resume will keep
      // failing identically — only a fresh session recovers.
      if (
        msg.includes("[ede_diagnostic]") ||
        msg.includes("Turn stalled") ||
        msg.includes("exceeded max duration")
      ) {
        this.sessions.clearSession(chatId);
      }
      const limitMatch = msg.match(/You've hit your limit[^"]*?(?=\\n|\n|$)/);
      if (limitMatch) {
        this.lastLimitEvent = { message: limitMatch[0].trim(), at: Date.now() };
      }
      // If the iterator is wedged, nudge the SDK subprocess so it has a
      // chance to exit cleanly. We don't await unbounded — interruptWithTimeout
      // caps it at 2s.
      await interruptWithTimeout(q);
      try {
        await this.bot.api.sendMessage(chatIdNum, `✗ turn failed: ${truncate(msg, 500)}`);
      } catch { /* ignore */ }
    } finally {
      this.active.delete(chatId);
      this.activeStartedAt.delete(chatId);
      this.advanceQueue(chatId);
    }
  }
}
