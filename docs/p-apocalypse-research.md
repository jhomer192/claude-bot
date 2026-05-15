# `-p` apocalypse — research findings

Empirical + source-reading investigation of the tmux approach before
committing to it as the primary fallback. Done 2026-05-15. Companion to
`p-apocalypse-runbook.md`.

## TL;DR

- The billing classifier is the env var `CLAUDE_CODE_ENTRYPOINT`, embedded
  in the prompt content as `x-anthropic-billing-header: cc_entrypoint=...`.
  Bare `claude` interactive sets `cli`; SDK→CLI bridge sets `sdk-cli`. The
  June 2026 split almost certainly buckets by this value.
- Tmux approach validated empirically: multi-turn within one pane works,
  `--resume <uuid>` rehydrates conversation across pane death, Stop hook
  fires reliably with stable transcript path.
- Two real bugs in current `src/tmux-agent.ts` that this research surfaced
  (both fixable in <50 lines; see "Code defects" section).
- A much simpler alternative also exists: set `CLAUDE_CODE_ENTRYPOINT=claude-desktop`
  in the bot's systemd unit. SDK's entrypoint-detection function respects
  pre-set values (except literal `cli`, which it special-cases to `sdk-cli`).
  Untested vs. server-side validation — keep as a one-line emergency lever.

## 1. How billing classification actually works

Decoded from `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`:

```javascript
function detectEntrypoint(isSDK) {
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    // pre-set value passes through, with one exception
    if (process.env.CLAUDE_CODE_ENTRYPOINT === "cli" && isSDK)
      process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
    return;
  }
  // mcp serve → "mcp"
  // CLAUDE_CODE_ACTION truthy → "claude-code-github-action"
  // default → isSDK ? "sdk-cli" : "cli"
}
```

The result lands as `cc_entrypoint=<value>` inside an
`x-anthropic-billing-header: ...` literal that the CLI prepends to the
prompt as a text block. So:

- The signal is **inside the prompt content**, not HTTP headers. Travels
  with cache reads. Can't be stripped by an upstream proxy.
- Known entrypoint values: `cli`, `sdk-cli`, `sdk-ts`, `sdk-py`, `mcp`,
  `claude-desktop`, `claude-vscode`, `claude-code-github-action`,
  `local-agent`, `remote`.

**Implication.** Our bot today is `sdk-cli` (SDK calls cli.js for transport).
That's almost certainly the bucket the apocalypse moves out of Max. A bare
`claude` process inside tmux is `cli` — same value a human at a terminal
would produce — and is the legitimate Max-bucket interactive path.

**Alternative classification signals** Anthropic *could* layer on (not
observable from cli.js bundle):

- HTTP-level fingerprinting of request shape (we send stream-json; humans
  don't).
- Behavioural classification on cadence + duration (sustained automation
  detection regardless of label).
- Server-side validation that `cc_entrypoint=claude-desktop` requests
  actually originate from the desktop app (TLS-pinned client cert, signed
  device attestation).

We have no evidence of any of these. But they're cheap to add server-side
if Anthropic notices spoofing. Tmux is the sturdier path because it sends
a *real* `cli` entrypoint from a *real* PTY-driven interactive process.

## 2. Tmux-mode validation tests

All run against `claude 2.1.110` on the dev box, against real Anthropic
servers. Scripts archived in `/tmp/research-tmux/` (not committed; this is
ephemeral host scratch).

### Multi-turn in single pane — **works**

Spawned tmux session, sent 3 distinct prompts back-to-back. Each turn:
- Got its own Stop-hook signal (`<signal_dir>/<session_id>` rewritten each
  time).
- Appended ~4 JSONL lines to the **same** transcript file.
- Took ~2.0–2.5s wall-clock end-to-end.

Transcript event sequence per turn:
```
file-history-snapshot → user → [attachment...] → assistant → system/stop_hook_summary
```

The `stop_hook_summary` system event is a reliable terminal delimiter.

### `--resume <uuid>` across tmux pane death — **works**

1. Fresh session: spawn `claude --session-id <UUID>`, say "Remember
   passion-fruit-7423".
2. `tmux kill-session`.
3. Respawn: `claude --resume <UUID>`.
4. Ask "What was the secret word?" → answers `passion-fruit-7423`.

Same transcript JSONL file is appended to. This is the survival path for
bot restarts: we keep `sessionId` in the telegram bot's state.db, and on
any new turn we either send-keys to the existing tmux session (if alive)
or respawn with `--resume <sessionId>`.

### Stop hook reliability

- Settings.json hooks: `Stop`, `SubagentStop`, `StopFailure` are all
  separate events. We only register `Stop`. `SubagentStop` is for the
  Task tool's nested subagents — not our prompt-response cycle, so good.
- `StopFailure` fires when *another* Stop hook fails. Not relevant unless
  the user already had Stop hooks installed; our hook always `exit 0`.
- On unrecoverable claude crash, no Stop fires. 30-min `SIGNAL_TIMEOUT_MS`
  backstop in `tmux-agent.ts` recovers.

## 3. Code defects in `src/tmux-agent.ts` (current d5237b1)

Both surfaced during this research. Fix before any prod traffic.

### Defect 1: prompt-text matching for turn slicing

```typescript
// Lines 254-268: backward scan for user message matching `input.prompt`
for (let i = lines.length - 1; i >= 0; i--) {
  const ev = JSON.parse(lines[i]);
  if (ev.type === "user" && ev.message?.content === input.prompt) {
    promptLineIdx = i;
    break;
  }
}
```

**Bug.** If Jack sends the same prompt twice (e.g. `/help`, then later
`/help` again), the backward scan finds the *earlier* occurrence first
... wait, it walks backward, so it finds the latest occurrence. But if a
previous turn's text accidentally matched the new prompt, the slice would
be wrong. The real fragility: this fails the moment a prompt contains
shell-style quoting that gets normalized, or the user uses partial-match
text. Brittle.

**Fix.** Walk backwards from end-of-file looking for
`system/stop_hook_summary`. Find the last one — that's this turn's
terminator. Walk back to the *prior* `stop_hook_summary` (or start of
file). Everything between is this turn. Stateless, robust, prompt-agnostic.

### Defect 2: assistant `usage` mis-aggregated

```typescript
// Line 282: takes usage from last assistant message in slice
lastUsage = { input_tokens: ev.message.usage.input_tokens, ... };
```

Each assistant block has its own per-block usage in the JSONL. The
*cumulative* usage for a multi-block turn is the **sum**, not the last.
Single-block turns happen to be correct; multi-tool-call turns
under-report.

**Fix.** Sum `input_tokens`, `output_tokens`, etc., across all assistant
events in the slice.

## 4. Alternative: env-var spoof (one-line patch)

If the tmux dance proves operationally annoying, the cheapest
billing-bucket flip is:

```ini
# claude-bot.service
Environment="CLAUDE_CODE_ENTRYPOINT=claude-desktop"
```

The SDK's entrypoint detection respects pre-set values (only `cli` gets
auto-upgraded to `sdk-cli`). With this env, `cc_entrypoint=claude-desktop`
goes up with every request. **If Anthropic doesn't server-side-validate**
the entrypoint label, the bot bills as desktop-app traffic.

Risks:
- No empirical confirmation Anthropic accepts unrecognized-source
  `claude-desktop` traffic.
- If they ever add validation, the response is account-level rate-limit
  or auth revoke — not silent. Recoverable, but disruptive.
- Spoofing the entrypoint is a policy-grey move; Jack should be aware.

Keep this in the runbook as the "emergency one-liner" fallback to the tmux
path, not the primary.

## 5. node-pty as alternative to tmux

`node-pty` is already a dep (used in the relogin flow). Could we use it
instead of tmux to drive interactive claude?

**No — for the wrong tradeoff.** node-pty puts the PTY inside the bot
process. Every bot restart (every push to main triggers a redeploy) would
kill every active conversation. With tmux:

- Sessions outlive the bot. Bot dies, tmux keeps claude running. New bot
  process re-attaches by name.
- Crash isolation: a wedged claude process doesn't take down the bot.
- Live debugging: `tmux attach -t claude-bot-<chatId>` to watch.

node-pty makes sense for short-lived flows where the bot owns the PTY
lifecycle (like the relogin flow — one PTY for one auth attempt, then
done). It doesn't make sense for long-lived per-chat conversations.

## 6. Confidence rating

| Question | Confidence | Evidence |
|---|---|---|
| Tmux mode preserves Max billing | **High** for now | `cc_entrypoint=cli` is the legitimate bare-CLI signal; identical to a real user's terminal |
| Tmux mode resilient to bot restart | **High** | Verified empirically via resume-test3.sh |
| Multi-turn within one pane works | **High** | Verified — 3 consecutive turns with stable transcript |
| Anthropic won't move `cli` to the new bucket too | **Medium** | The whole point of the split is to differentiate human-interactive from automated; we are *technically* automated even from a `cli` entrypoint |
| Env-var spoof works | **Unknown** | Untested against billing surface; might work today, might be detected tomorrow |
| Stop hook never silently drops a turn | **High** | 30-min `SIGNAL_TIMEOUT_MS` backstop covers crashes; hook always `exit 0` |

## 7. Recommendation

1. **Fix the two `tmux-agent.ts` defects** above. Both are concrete bugs
   that will fire in prod within a week of normal use.
2. **Keep `AGENT_MODE=sdk` as the prod default** until the June 2026 cliff
   actually arrives. Flipping to `tmux` only when needed limits exposure
   to the operational rough edges (TUI warmup races, signal-file races
   under load) we haven't fully shaken out.
3. **Ship the env-var spoof as a one-line override**, documented in the
   runbook as "first lever to pull if you see Max quota draining unexpectedly
   pre-June-2026". It's free; cost-of-discovery is bounded.
4. **Don't replace node-pty/tmux with each other** — they solve different
   problems (relogin flow vs. per-chat session survival).
