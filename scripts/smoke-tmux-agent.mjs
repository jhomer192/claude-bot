// Smoke-test the compiled tmux-agent end-to-end without the full bot.
// Builds the dist via tsc first, then drives one turn against a real
// tmux'd claude on this host. Prints every event the agent emits.
//
// Usage:
//   npm run build && node scripts/smoke-tmux-agent.mjs "what is two plus two"
//
// Asserts:
//   - emits exactly one `system/init` event
//   - emits at least one `assistant` event with a text block
//   - emits exactly one `result` event
//   - exits 0
//
// Cleans up the tmux session it spawned on exit.

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const hookPath = join(repoRoot, "hooks/on-stop.sh");

const prompt = process.argv[2] ?? "Reply with exactly: PONG";
const chatId = `smoke-${process.pid}`;

const work = await mkdtemp(join(tmpdir(), "smoke-tmux-"));
const cwd = join(work, "workdir");
const signalDir = join(work, "signals");
const settingsPath = join(work, "settings.json");
await mkdir(cwd, { recursive: true });
await mkdir(signalDir, { recursive: true });
await writeFile(
  settingsPath,
  JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: hookPath }] }] },
  }),
);

// Import after building so we get the freshly compiled dist.
const { startTmuxTurn, tmuxSessionName } = await import(
  join(repoRoot, "dist/tmux-agent.js")
);

const handle = startTmuxTurn({
  prompt,
  sessionId: null,
  cwd,
  model: "claude-opus-4-7",
  chatId,
  signalDir,
  settingsPath,
});

let initCount = 0;
let assistantTextCount = 0;
let resultCount = 0;
let lastResult = null;

const cleanup = () => {
  try {
    execSync(`tmux kill-session -t '${tmuxSessionName(chatId)}' 2>/dev/null`, {
      stdio: "ignore",
    });
  } catch {}
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

try {
  for await (const event of handle) {
    if (event.type === "system" && event.subtype === "init") {
      initCount += 1;
      console.log(`[event] system/init session_id=${event.session_id}`);
    } else if (event.type === "assistant") {
      const blocks = event.message?.content ?? [];
      for (const b of blocks) {
        if (b?.type === "text") {
          assistantTextCount += 1;
          console.log(`[event] assistant/text: ${JSON.stringify(b.text)}`);
        } else if (b?.type === "tool_use") {
          console.log(`[event] assistant/tool_use ${b.name}`);
        }
      }
    } else if (event.type === "result") {
      resultCount += 1;
      lastResult = event;
      console.log(
        `[event] result subtype=${event.subtype} num_turns=${event.num_turns} duration_ms=${event.duration_ms} usage=${JSON.stringify(event.usage)}`,
      );
    }
  }
} finally {
  cleanup();
}

const fails = [];
if (initCount !== 1) fails.push(`expected 1 init, got ${initCount}`);
if (assistantTextCount < 1) fails.push(`expected >=1 assistant text, got ${assistantTextCount}`);
if (resultCount !== 1) fails.push(`expected 1 result, got ${resultCount}`);
if (lastResult && lastResult.subtype !== "success") {
  fails.push(`result subtype was ${lastResult.subtype}, expected success`);
}

if (fails.length) {
  console.error("\nFAIL:");
  fails.forEach((f) => console.error("  -", f));
  process.exit(1);
}
console.log("\nPASS — tmux-agent emits the full SDK-shaped event sequence.");
