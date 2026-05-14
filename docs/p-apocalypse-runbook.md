# `-p` apocalypse runbook

**Problem:** starting 2026-06, `claude -p` (non-interactive CLI) usage moves
to a separate quota bank from Jack's interactive Claude Max. This bot runs
the Agent SDK, which spawns `cli.js` over stdio — counts as `-p` for
billing. After the cut, bot turns no longer count against Max; they count
against a separate (size-unknown) bucket.

**Goal:** keep bot usage on Max. Don't pay per token. Don't depend on
Anthropic being generous with the new bucket.

## The plan: drive `claude` interactively in tmux

Interactive mode (no `-p`) bills against Max — that's the whole point of
the workaround. We run one `claude` per chat inside a tmux session, send
prompts via `tmux send-keys`, and detect turn completion via a Claude Code
**Stop hook** that writes a signal file. The bot reads the JSONL
transcript (perfect structured event stream, no TUI scraping) and renders
to Telegram exactly like today.

### Why tmux specifically (not raw node-pty)

- **Session survives bot restart.** tmux sessions are independent processes.
  When systemd restarts the bot, the in-flight `claude` keeps running.
  node-pty dies with its parent — we'd lose unsent output.
- **Manual debugging:** `tmux attach -t claude-<chatId>` lets Jack peek at
  any session's TUI directly when something's weird.
- **Mature multiplexer:** tmux handles PTY allocation, scrollback,
  reconnection. We don't reinvent.

### Why hooks (not TUI scraping)

The Stop hook gives us the transcript file path on every turn completion.
The transcript is JSONL — same structured events the Agent SDK currently
emits. We get tool_use blocks, text blocks, costs, usage — everything —
without parsing Ink rendering. **Zero loss of fidelity vs SDK mode.**

## Architecture

```
Telegram msg → bot
              ↓
              tmux send-keys -t claude-<chatId> -l "<prompt>"
              tmux send-keys -t claude-<chatId> Enter
              ↓
              [claude processes, runs tools, writes text]
              ↓
              Stop hook fires
                $ on-stop.sh
                  → reads {session_id, transcript_path} from stdin
                  → writes transcript_path to /var/lib/claude-bot/stop-signals/<session_id>
              ↓
              bot watches stop-signals/ via fs.watch
              ↓
              bot reads transcript JSONL from saved offset
              parses new assistant message blocks
              → renders to Telegram (same StreamingRenderer as today)
```

## Status of the migration

- [x] Stop-hook script and setup tooling shipped
- [x] POC verifies the loop end-to-end on this box
- [ ] `src/tmux-agent.ts` — drop-in replacement for `src/agent.ts`
- [ ] `AGENT_MODE=tmux` env flag in `src/config.ts`
- [ ] `runTurn` in `src/telegram.ts` routes to tmux-agent when flag is set
- [ ] Migration script: existing SDK-managed sessions → tmux sessions
- [ ] Production cutover (after we know what June's `-p` bank actually looks like)

## Operations

### Enable tmux mode (one-time, per host)

```bash
sudo ./scripts/setup-tmux-mode.sh
# Installs ~/.claude/settings.json Stop hook for the `claude` service user.
# Creates /var/lib/claude-bot/stop-signals/ with correct perms.
```

### Run the POC to verify

```bash
./scripts/poc-tmux-claude.sh
# Spawns a tmux'd claude in /tmp, sends a one-line prompt, waits for the
# Stop hook to fire, prints the assistant's reply parsed from the
# transcript. Exits 0 on success.
```

### Inspect a live session

```bash
tmux attach -t claude-<chatId>
# Read-only is safer: add `-r`.
# Detach with C-b d (or C-b R d if your prefix is different).
```

### Kill a stuck session

```bash
tmux kill-session -t claude-<chatId>
# bot will spawn a fresh one (with `claude --resume <uuid>`) on the next message
```

## Fallback: API billing (last resort, costs money)

If tmux mode breaks for any reason — Anthropic adds TTY-automation
detection, hook semantics change, whatever — we can fall back to pay-per-
token API billing. Scripts kept for this emergency:

- `scripts/flip-billing-mode.sh api sk-ant-...` — toggle `.env`
- `scripts/smoke-api-key-mode.sh` — verify a key works before flipping

We do **not** use API mode preemptively. Tmux is the plan.

## Decision checkpoint: 2026-06

| New `-p` bank looks like... | Action |
|---|---|
| ≥ current usage headroom | Stay on SDK mode, do nothing |
| Tight | Cut over to tmux mode (this runbook) |
| Tmux mode also broken somehow | Flip to API billing (emergency only) |
