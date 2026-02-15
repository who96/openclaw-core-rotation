---
name: core-rotation
description: >
  Automatically rotates agent sessions when compaction count exceeds a
  configurable threshold, preventing cumulative context degradation.
  Archives the old session, creates a fresh one, and injects inherited
  memory (MEMORY.md, daily logs, recent messages) into the new session.
events:
  - after_compaction
  - gateway:startup
---

# Core Rotation Hook

## What it does

When an OpenClaw agent session undergoes repeated compaction (lossy context
summarization), information quality degrades exponentially. This hook detects
that degradation by counting compactions, then performs an automatic "core
rotation": the old session is archived, a new session is created, and key
state (long-term memory, daily logs, recent conversation) is injected into
the fresh session.

## Events

### `after_compaction`

Fires after each compaction cycle completes. The plugin reads the current
`compactionCount` from `sessions.json`. If it meets or exceeds the configured
threshold (default: 3), and no active tasks are running, and cooldown/circuit
breaker conditions allow it, the rotation process begins.

### `gateway:startup`

Fires when the OpenClaw gateway process starts (or restarts). The plugin reads
`rotation-state.json` and resumes any interrupted rotation from the last
persisted state, or safely rolls back if recovery is not possible.

## Configuration

All settings live under `plugins["core-rotation"]` in `openclaw.json`.
See `src/types.ts` for the full `RotationConfig` interface and defaults.

## State Machine

```
IDLE -> PENDING -> ARCHIVING -> ARCHIVED -> INJECTED -> COOLDOWN -> IDLE
```

Each transition is persisted to `rotation-state.json` via atomic
write-then-rename before the next step executes, ensuring crash safety.
