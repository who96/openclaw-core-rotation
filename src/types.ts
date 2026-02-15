/**
 * OpenClaw Core Rotation Plugin — Type Definitions
 *
 * All interfaces for the crash-safe session rotation state machine.
 * Zero external dependencies: only Node.js stdlib types referenced.
 */

// ---------------------------------------------------------------------------
// State Machine
// ---------------------------------------------------------------------------

/** The six states of the rotation FSM. */
export type RotationStateName =
  | 'IDLE'
  | 'PENDING'
  | 'ARCHIVING'
  | 'ARCHIVED'
  | 'INJECTED'
  | 'COOLDOWN';

/**
 * Persisted to `~/.openclaw/agents/{agentId}/rotation-state.json`.
 * Written via write-then-rename for POSIX atomic crash safety.
 */
export interface RotationState {
  version: 1;
  state: RotationStateName;

  /** ISO-8601 timestamp when this rotation cycle started. */
  startedAt: string | null;

  /** Session ID of the session being replaced. */
  oldSessionId: string | null;

  /** Filesystem path to the old session JSONL file. */
  oldSessionFile: string | null;

  /** Filesystem path where the old session was archived. */
  archivePath: string | null;

  /** Session ID of the freshly created replacement session. */
  newSessionId: string | null;

  /** ISO-8601 timestamp. Rotation blocked until this time passes. */
  cooldownUntil: string | null;

  /** The compactionCount value that triggered this rotation. */
  triggerCompactionCount: number | null;

  /** Append-only log of completed rotations. */
  rotationHistory: RotationHistoryEntry[];

  /** Estimated tokens of the injection payload. Set during INJECTED transition. */
  injectedTokensEstimate: number | null;

  /** Last error message, if any step failed. Cleared on recovery. */
  error: string | null;

  /** ISO-8601 timestamp of the last state file write. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Rotation History
// ---------------------------------------------------------------------------

export interface RotationHistoryEntry {
  rotatedAt: string;
  oldSessionId: string;
  newSessionId: string;
  triggerCompactionCount: number;
  injectedTokensEstimate: number;
}

// ---------------------------------------------------------------------------
// Plugin Configuration
// ---------------------------------------------------------------------------

/** Cooldown guards: both conditions must be satisfied before next rotation. */
export interface CooldownConfig {
  /** Minimum compactions since last rotation before allowing another. */
  minCompactions: number;
  /** Minimum wall-clock minutes since last rotation. */
  minMinutes: number;
}

/** Circuit breaker: stops automatic rotation if firing too often. */
export interface CircuitBreakerConfig {
  /** Max rotations allowed within the window. */
  maxRotations: number;
  /** Rolling window in minutes. */
  windowMinutes: number;
}

/**
 * Plugin configuration read from `openclaw.json` under
 * `plugins["core-rotation"]`.
 */
export interface RotationConfig {
  enabled: boolean;

  /** Rotation triggers when `compactionCount >= compactionCountThreshold`. */
  compactionCountThreshold: number;

  /**
   * Max injection size as a fraction of contextWindow.
   * 0.15 = 15%.
   */
  injectionBudgetPercent: number;

  /** Number of recent user+assistant message pairs to inject. */
  recentMessagePairs: number;

  /** What to do with the old session file after rotation. */
  oldSessionPolicy: 'archive' | 'delete';

  /** Send a notification message to the user's channel on rotation. */
  notifyOnRotation: boolean;

  cooldown: CooldownConfig;
  circuitBreaker: CircuitBreakerConfig;
}

// ---------------------------------------------------------------------------
// Default Configuration
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: RotationConfig = {
  enabled: true,
  compactionCountThreshold: 3,
  injectionBudgetPercent: 0.15,
  recentMessagePairs: 5,
  oldSessionPolicy: 'archive',
  notifyOnRotation: true,
  cooldown: {
    minCompactions: 3,
    minMinutes: 30,
  },
  circuitBreaker: {
    maxRotations: 3,
    windowMinutes: 30,
  },
};

// ---------------------------------------------------------------------------
// Default (empty) Rotation State
// ---------------------------------------------------------------------------

export const DEFAULT_STATE: RotationState = {
  version: 1,
  state: 'IDLE',
  startedAt: null,
  oldSessionId: null,
  oldSessionFile: null,
  archivePath: null,
  newSessionId: null,
  cooldownUntil: null,
  triggerCompactionCount: null,
  injectedTokensEstimate: null,
  rotationHistory: [],
  error: null,
  updatedAt: '1970-01-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// OpenClaw Session Metadata (subset of sessions.json we need)
// ---------------------------------------------------------------------------

/**
 * A single entry from `sessions.json`.
 * We only read the fields relevant to rotation decisions.
 */
export interface SessionEntry {
  sessionId: string;
  compactionCount: number;
  memoryFlushAt: string | null;
  memoryFlushCompactionCount: number;
  updatedAt: string;
  contextTokens?: number;
}

// ---------------------------------------------------------------------------
// OpenClaw Hook Event Context
// ---------------------------------------------------------------------------

/**
 * Context object passed to hook handlers by the OpenClaw Plugin SDK.
 * Based on observed patterns from OpenClaw hook documentation and PR #14882.
 */
export interface HookContext {
  /** The agent ID this event belongs to. */
  agentId: string;

  /** ID of the current active session. */
  sessionId: string;

  /** Absolute path to the agent's data directory. */
  agentDir: string;

  /** Absolute path to the workspace directory. */
  workspaceDir: string;

  /** The context window size in tokens for the current model. */
  contextWindow: number;
}

/**
 * Event payload for `after_compaction`.
 * Contains the hook context plus compaction-specific data.
 */
export interface AfterCompactionEvent {
  hook: 'after_compaction';
  context: HookContext;

  /** Current compaction count after this compaction completed. */
  compactionCount: number;

  /** Session metadata snapshot at time of event. */
  session: SessionEntry;
}

/**
 * Event payload for `gateway:startup`.
 * Contains the hook context for crash recovery.
 */
export interface GatewayStartupEvent {
  hook: 'gateway:startup';
  context: HookContext;
}

/** Union of all events this plugin handles. */
export type PluginEvent = AfterCompactionEvent | GatewayStartupEvent;

// ---------------------------------------------------------------------------
// Injection Payload
// ---------------------------------------------------------------------------

/** Structured content assembled for injection into a new session. */
export interface InjectionPayload {
  /** Contents of MEMORY.md (may be truncated). */
  longTermMemory: string;

  /** Contents of today's daily log, or empty string. */
  todayLog: string;

  /** Contents of yesterday's daily log, or empty string. */
  yesterdayLog: string;

  /** Recent message pairs extracted from old session JSONL. */
  recentMessages: MessagePair[];

  /** Metadata block about this rotation. */
  metadata: RotationMetadata;

  /** Estimated total tokens for the assembled payload. */
  estimatedTokens: number;
}

export interface MessagePair {
  user: string;
  assistant: string;
}

export interface RotationMetadata {
  rotationNumber: number;
  reason: string;
  previousSessionId: string;
  archivePath: string;
  compactionCount: number;
}

// ---------------------------------------------------------------------------
// Valid State Transitions (for runtime assertion)
// ---------------------------------------------------------------------------

/**
 * Map of allowed transitions. Used by writeState() to assert
 * the FSM never enters an illegal state.
 */
export const VALID_TRANSITIONS: Record<RotationStateName, RotationStateName[]> = {
  IDLE:      ['PENDING'],
  PENDING:   ['IDLE', 'ARCHIVING'],
  ARCHIVING: ['ARCHIVED', 'PENDING'],
  ARCHIVED:  ['INJECTED'],
  INJECTED:  ['COOLDOWN'],
  COOLDOWN:  ['IDLE'],
};
