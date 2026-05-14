# `-p` apocalypse runbook

**Read this first if the bot stops responding in or after June 2026.**

## Background

Starting **2026-06**, Anthropic moves `claude -p` (non-interactive CLI) usage
to a separate quota bank from interactive Claude Max. This bot runs the
Agent SDK, which spawns `cli.js` over stdio — functionally `-p` for billing
purposes. When the new bank lands, three things can happen:

1. **New bank is generous.** Do nothing.
2. **New bank is tight.** Bot starts failing with rate-limit errors. Flip
   to Path A (below).
3. **Both unworkable.** Build Path B (tmux send-keys).

We do **not** migrate preemptively. We prep, we wait, we flip if needed.

## Path A — switch to API billing (preferred, ~5 minutes)

`src/config.ts:33` already supports this: if `ANTHROPIC_API_KEY` is set,
the SDK uses it automatically. No code changes needed.

**Steps:**

```bash
# 1. On a workstation, mint a key at https://console.anthropic.com/
#    Workspace → API Keys → Create Key. Save to ~/.secrets/side-projects.gpg.

# 2. On the VPS:
ssh vps
sudo /opt/claude-bot/scripts/flip-billing-mode.sh api sk-ant-api03-...
# (script edits /etc/claude-bot.env and restarts the service)

# 3. Verify:
sudo journalctl -u claude-bot -n 20 --no-pager
# look for clean startup, no auth errors

# 4. Send a Telegram message to the bot. Confirm it responds.

# 5. After ~1 hour of normal use, check the Anthropic console for the
#    expected token spend. If billing didn't move, the SDK is still
#    falling back to Max — check that ANTHROPIC_API_KEY is exported in
#    /etc/claude-bot.env and that the service was restarted, not reloaded.
```

**Cost expectations** (Opus 4 list pricing as of 2026-05):
- Input: $15 / 1M tokens (~$0.015 per turn at typical input size)
- Output: $75 / 1M tokens (~$0.075 per turn)
- Heavy bot day (~50 turns): $2–5
- Auto-applier-bot under the same key may dwarf this; budget separately

**To flip back to Max:**

```bash
sudo /opt/claude-bot/scripts/flip-billing-mode.sh max
```

This blanks `ANTHROPIC_API_KEY` and restarts. The SDK falls back to the
Claude Code login at `~/.claude/.credentials.json` on the host.

## Path B — tmux send-keys (last resort, ~3 days build)

Run `claude` interactively in a tmux session per Telegram chat. Drive via
`tmux send-keys`, scrape Ink TUI output back. Keeps usage on Max bank
because interactive mode is classified as human use.

**Not scaffolded.** Only build if Path A pricing is unworkable AND the new
`-p` bank is tight. Sketch:

1. Replace `agent.ts` with a tmux-session manager (one session per chat).
2. Stream `tmux capture-pane` output diffs to parse responses.
3. Strip ANSI / Ink markup to reconstruct text + tool-call events.
4. Persist tmux session names to SQLite (parallels current `sessionId` map).

Risks: Anthropic can detect headless TTY (no DISPLAY, predictable cadence,
xterm-256color in a container) and reclassify. Migration becomes sunk cost
overnight. Also loses the SDK's structured event stream — we'd reverse-
engineer it from the TUI.

## Smoke test (run quarterly while on Max)

`scripts/smoke-api-key-mode.sh` provisions a throwaway config, runs one
turn, and confirms the SDK accepts the API key. Run this before June and
every ~90 days to ensure Path A still works:

```bash
./scripts/smoke-api-key-mode.sh sk-ant-api03-...
# prints PASS or FAIL with a clear reason
```

## What we do NOT do

- ❌ Migrate to Path A preemptively. Max is currently cheaper.
- ❌ Build Path B scaffolding. Wait until we know we need it.
- ❌ Add a "billing mode" abstraction in code. One env var is already
  enough; the SDK handles the rest.
- ❌ Throttle the bot to "save" Max quota. Path A flip is the answer, not
  artificial throttling.

## Decision checkpoint when June lands

| New `-p` bank looks like... | Action |
|---|---|
| ≥ current Max usage headroom | Stay on Max, do nothing |
| Tight but not zero | Flip Path A, run on API billing |
| Effectively unusable + API too expensive | Build Path B |
