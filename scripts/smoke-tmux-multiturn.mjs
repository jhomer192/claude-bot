// Multi-turn smoke: drive 3 consecutive turns through one tmux session,
// confirm each turn's assistant text only includes that turn's reply (no
// leakage from earlier turns). Catches the stop_hook_summary slicing bug.
//
// Usage: npm run build && node scripts/smoke-tmux-multiturn.mjs

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const hookPath = join(repoRoot, "hooks/on-stop.sh");

const chatId = `smokemt-${process.pid}`;

const work = await mkdtemp(join(tmpdir(), "smoke-tmux-mt-"));
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

const { startTmuxTurn, tmuxSessionName } = await import(
  join(repoRoot, "dist/tmux-agent.js")
);

const cleanup = () => {
  try {
    execSync(`tmux kill-session -t '${tmuxSessionName(chatId)}' 2>/dev/null`, {
      stdio: "ignore",
    });
  } catch {}
};
process.on("SIGINT", () => { cleanup(); process.exit(130); });

let sessionId = null;
const turns = [
  { prompt: "Say exactly: MARKER-ONE", tag: "MARKER-ONE", other: ["MARKER-TWO","MARKER-THREE"] },
  { prompt: "Say exactly: MARKER-TWO", tag: "MARKER-TWO", other: ["MARKER-ONE","MARKER-THREE"] },
  { prompt: "Say exactly: MARKER-THREE", tag: "MARKER-THREE", other: ["MARKER-ONE","MARKER-TWO"] },
];

const fails = [];

try {
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    console.log(`\n=== Turn ${i+1}: prompt=${JSON.stringify(t.prompt)} ===`);
    const handle = startTmuxTurn({
      prompt: t.prompt,
      sessionId,
      cwd,
      model: "claude-opus-4-7",
      chatId,
      signalDir,
      settingsPath,
    });

    let assistantText = "";
    let turnSessionId = null;
    for await (const ev of handle) {
      if (ev.type === "system" && ev.subtype === "init") {
        turnSessionId = ev.session_id;
      } else if (ev.type === "assistant") {
        for (const b of ev.message?.content ?? []) {
          if (b?.type === "text") assistantText += b.text;
        }
      } else if (ev.type === "result") {
        console.log(`  result subtype=${ev.subtype} num_turns=${ev.num_turns} duration=${ev.duration_ms}ms usage=${JSON.stringify(ev.usage)}`);
      }
    }
    sessionId = turnSessionId; // reuse for next turn
    console.log(`  assistant text: ${JSON.stringify(assistantText.slice(0, 120))}`);

    if (!assistantText.includes(t.tag)) {
      fails.push(`turn ${i+1}: missing own tag ${t.tag}`);
    }
    for (const otherTag of t.other) {
      if (assistantText.includes(otherTag)) {
        fails.push(`turn ${i+1}: LEAKED prior-turn tag ${otherTag} into assistantText`);
      }
    }
  }
} finally {
  cleanup();
}

if (fails.length) {
  console.error("\nFAIL:");
  fails.forEach((f) => console.error("  -", f));
  process.exit(1);
}
console.log("\nPASS — multi-turn slicing is leak-free.");
