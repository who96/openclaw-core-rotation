# Core Rotation Plugin for OpenClaw

**[中文版 README](./README_CN.md)**

> Your AI agent's brain degrades after hours of conversation. This plugin swaps in a fresh one — automatically.

---

## The Problem

OpenClaw keeps your AI agent alive 24/7 across Telegram, Discord, and other channels. But there's a hidden cost: **compaction**.

Every time the context window fills up, OpenClaw compresses old conversations into summaries. This is lossy. After 3+ rounds of compression, critical instructions get mangled, exit conditions vanish, and your bot starts behaving unpredictably — while still *looking* fine.

**Real example:** A boot self-check rule containing `NO_REPLY` got partially compressed. The exit condition was lost, but the rule body survived. Result: the bot applied `NO_REPLY` to every subsequent message, silently breaking all conversations.

## The Solution

**Core Rotation** detects when your agent's "brain" has been compressed too many times, then performs an automatic "chip swap":

1. **Detect** — Hooks into OpenClaw's `after_compaction` event. When `compactionCount` hits the threshold (default: 3), rotation begins.
2. **Archive** — Safely copies the old session to `sessions/archive/`. The old data is never lost.
3. **Inject** — Reads your agent's existing memory files (MEMORY.md, daily logs) plus the last 5 conversation exchanges, and injects them into a fresh session.
4. **Coordinate** — Waits for active tasks to finish. Prevents rotation storms with a circuit breaker. Recovers from crashes automatically.

**The result:** Your bot gets a clean context window with all the important memories preserved — like a brain transplant where the memories come along.

## Why This Works

| Design Choice | Why |
|---|---|
| **Compaction count trigger** (not timer, not context%) | Directly measures "how many times has information been lossily compressed" — the actual cause of degradation |
| **Reuses OpenClaw's memory flush** | OpenClaw already saves important context to disk *before* each compaction. We just read those files instead of asking a degraded agent to summarize itself |
| **Single code path** | No if/else strategy selection. One way to detect, one way to rotate, one way to inject. Fewer branches = fewer bugs |
| **Crash-safe state machine** | Every step is persisted before execution. Gateway crashes mid-rotation? It picks up right where it left off |
| **Zero external dependencies** | Pure Node.js stdlib + OpenClaw Plugin SDK types. Install and go |

## Quick Start

### Install

```bash
git clone https://github.com/who96/openclaw-core-rotation.git
cd openclaw-core-rotation
npm install
npm run build
```

### Register with OpenClaw

Copy the built plugin to your OpenClaw local-plugins directory:

```bash
cp -r . ~/.openclaw/workspace/local-plugins/core-rotation/
```

Add to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "core-rotation": { "enabled": true }
    }
  }
}
```

### Configure (Optional)

Edit `~/.openclaw/workspace/local-plugins/core-rotation/config.json`:

```json
{
  "enabled": true,
  "compactionCountThreshold": 3,
  "injectionBudgetPercent": 0.15,
  "recentMessagePairs": 5,
  "notifyOnRotation": false,
  "cooldown": {
    "minCompactions": 3,
    "minMinutes": 30
  },
  "circuitBreaker": {
    "maxRotations": 3,
    "windowMinutes": 30
  }
}
```

### Verify

Restart your OpenClaw gateway. Check the logs for plugin load confirmation. The plugin will automatically activate when any agent's `compactionCount` reaches the threshold.

## How It Works

```
after_compaction event fires
        |
        v
compactionCount >= 3?  --No--> wait
        |
       Yes
        |
        v
Active tasks running?  --Yes--> defer
        |
       No
        |
        v
+------ PHASE 1: ARCHIVE (safe, non-destructive) ------+
|  copy session.jsonl --> sessions/archive/              |
|  validate archive completeness                        |
+-------------------------------------------------------+
        |
        v
+------ PHASE 2: RESET + INJECT (combined, fast) ------+
|  read MEMORY.md + daily logs + last 5 exchanges       |
|  check token budget (15% of context window)           |
|  create fresh session with injected state             |
+-------------------------------------------------------+
        |
        v
    COOLDOWN (30 min + 3 compactions minimum)
```

### Anti-Death-Loop Protection (4 Layers)

| Layer | Mechanism |
|---|---|
| Hard cap | Injection truncated if > 15% of context window |
| Circuit breaker | Stops after 3 rotations in 30 minutes |
| Exponential backoff | Budget shrinks: 15% → 10% → 5% on consecutive rotations |
| Health check | If new session hits compaction within 10 turns, future budget reduced |

### Crash Safety

The plugin uses a 6-state machine persisted via atomic write-then-rename:

```
IDLE → PENDING → ARCHIVING → ARCHIVED → INJECTED → COOLDOWN → IDLE
```

If the gateway crashes at *any* point, the `gateway:startup` hook reads the state file and resumes or safely rolls back.

## Requirements

- OpenClaw >= v2026.2.0 (requires `after_compaction` hook from PR #14882)
- Node.js >= 18

## Project Structure

```
core-rotation/
├── openclaw.plugin.json     # Plugin manifest
├── package.json             # npm package with openclaw.extensions
├── HOOK.md                  # Hook event declarations
├── config.json              # Default configuration
├── src/
│   ├── types.ts             # TypeScript interfaces & FSM transition table
│   ├── handler.ts           # Core logic (~500 lines)
│   └── __tests__/
│       └── handler.test.ts  # 68 tests, 0 failures
└── docs/
    └── spec.md              # Full requirements specification (v2)
```

## Tests

```bash
npm run build
npm test
# 68 tests, 12 suites, 0 failures
```

## Roadmap

- [x] Compaction-count-based degradation detection
- [x] Crash-safe session rotation with state machine
- [x] Memory-aware injection with token budget
- [x] Anti-death-loop protection (4 layers)
- [ ] User notification on rotation (needs channel API)
- [ ] Manual trigger command (`/rotate`)
- [ ] Direct `sessions.json` pointer update
- [ ] Configurable injection template

## Credits

- Inspired by [DAOKit](https://github.com/who96/DAOKit)'s Observer-Relay + Core Rotation architecture
- Built for [OpenClaw](https://github.com/openclaw/openclaw)

## License

MIT
