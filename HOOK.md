---
name: core-rotation
description: "Automatic session rotation on compaction-driven context degradation"
metadata:
  {
    "openclaw":
      {
        "events": ["after_compaction", "gateway:startup"],
      },
  }
---

# Core Rotation Hook

## What it does

When an OpenClaw agent session undergoes repeated compaction (lossy context
summarization), information quality degrades exponentially. This hook detects
that degradation by counting compactions, then performs an automatic "core
rotation": the old session is archived, a new session is created, and key
state (long-term memory, daily logs, recent messages) is injected into
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

## Installation

The hook must be registered in the Gateway's managed hooks directory:

```
~/.openclaw/hooks/core-rotation/
├── handler.js  -> symlink to local-plugins/core-rotation/hooks/core-rotation.js
└── HOOK.md     (this file, with metadata.openclaw.events frontmatter)
```

**Important**: The `HOOK.md` frontmatter must use `metadata.openclaw.events`
format (not top-level `events`), and the CJS bridge must export `.default`.

## Configuration

All settings live under `plugins["core-rotation"]` in `openclaw.json`.
See `src/types.ts` for the full `RotationConfig` interface and defaults.

## State Machine

```
IDLE -> PENDING -> ARCHIVING -> ARCHIVED -> INJECTED -> COOLDOWN -> IDLE
```

Each transition is persisted to `rotation-state.json` via atomic
write-then-rename before the next step executes, ensuring crash safety.
