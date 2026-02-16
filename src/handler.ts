/**
 * OpenClaw Core Rotation Plugin — Handler
 *
 * Crash-safe session rotation: detect degradation via compaction count,
 * archive old session, inject memory into fresh session.
 *
 * Zero external dependencies. Single code path.
 */

import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import type {
  RotationConfig,
  RotationState,
  RotationStateName,
  AfterCompactionEvent,
  GatewayStartupEvent,
  GatewayContext,
  InjectionPayload,
  MessagePair,
  RotationMetadata,
  RotationHistoryEntry,
} from './types.ts';
import { DEFAULT_CONFIG, DEFAULT_STATE, VALID_TRANSITIONS } from './types.ts';

// ---------------------------------------------------------------------------
// Helper: Derive Agent Directory
// ---------------------------------------------------------------------------

/**
 * workspaceDir is a subdirectory of the agent root.
 * Agent root (where `rotation-state.json` and `sessions/` live) is the parent.
 */
export function deriveAgentDir(ctx: Partial<GatewayContext>): string | null {
  if (!ctx?.workspaceDir) return null;
  return resolve(ctx.workspaceDir, '..');
}

// ---------------------------------------------------------------------------
// Plugin Entry Point
// ---------------------------------------------------------------------------

export default function register(api: { on: (event: string, handler: (...args: any[]) => void) => void }): void {
  api.on('after_compaction', (event: any, ctx: any) => onAfterCompaction(event, ctx ?? {}));
  api.on('gateway:startup', (event: any, ctx: any) => onGatewayStartup(event, ctx ?? {}));
}

// ---------------------------------------------------------------------------
// Hook Handlers
// ---------------------------------------------------------------------------

export function onAfterCompaction(event: AfterCompactionEvent, ctx: Partial<GatewayContext>): void {
  // Defensive check first
  const agentDir = deriveAgentDir(ctx);
  if (!agentDir) return;

  const config = loadConfig(agentDir);
  if (!config.enabled) return;

  let state = readState(agentDir);

  // Self-track cumulative compaction count
  const cumulativeCount = state.cumulativeCompactionCount + 1;
  // Update state on disk immediately (even if we don't rotate)
  state = patchState(agentDir, state, { cumulativeCompactionCount: cumulativeCount });

  // If in COOLDOWN, check expiry
  if (state.state === 'COOLDOWN') {
    if (state.cooldownUntil && new Date(state.cooldownUntil) <= new Date()) {
      writeState(agentDir, state, 'IDLE', { cooldownUntil: null });
    }
    return;
  }

  if (state.state !== 'IDLE') return;

  // Check compaction threshold using cumulative count
  if (cumulativeCount < config.compactionCountThreshold) return;

  // Circuit breaker
  if (!checkCircuitBreaker(state, config)) return;

  // Cooldown guard (pass cumulative count)
  if (isInCooldown(state, config, cumulativeCount)) return;

  // Active task check: use sessionFile from event
  if (hasActiveTasks(event.sessionFile)) return;

  // All checks passed — rotate
  rotate(config, event, ctx, agentDir, cumulativeCount);
}

export function onGatewayStartup(event: GatewayStartupEvent, ctx: Partial<GatewayContext>): void {
  // Defensive check
  const agentDir = deriveAgentDir(ctx);
  if (!agentDir) return;

  const state = readState(agentDir);

  switch (state.state) {
    case 'IDLE':
      return;

    case 'PENDING':
      writeState(agentDir, state, 'IDLE', {});
      return;

    case 'ARCHIVING': {
      if (state.archivePath && state.oldSessionFile && validateArchive(state.archivePath, state.oldSessionFile)) {
        writeState(agentDir, state, 'ARCHIVED', {});
      } else {
        // Cleanup partial archive
        if (state.archivePath) {
          try { unlinkSync(state.archivePath); } catch { /* file may already be gone */ }
        }
        writeState(agentDir, state, 'PENDING', { archivePath: null });
        // Fall back to IDLE — re-evaluate on next compaction
        const updated = readState(agentDir);
        writeState(agentDir, updated, 'IDLE', {});
      }
      return;
    }

    case 'ARCHIVED': {
      // Safe recovery point — execute Phase 2
      const config = loadConfig(agentDir);
      rotatePhase2(config, ctx, agentDir, readState(agentDir));
      return;
    }

    case 'INJECTED': {
      const config = loadConfig(agentDir);
      finishRotation(agentDir, readState(agentDir), config);
      return;
    }

    case 'COOLDOWN': {
      if (state.cooldownUntil && new Date(state.cooldownUntil) <= new Date()) {
        writeState(agentDir, state, 'IDLE', { cooldownUntil: null });
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Rotation Logic
// ---------------------------------------------------------------------------

export function rotate(
  config: RotationConfig,
  event: AfterCompactionEvent,
  ctx: Partial<GatewayContext>,
  agentDir: string,
  cumulativeCount: number,
): void {
  const sessionFile = event.sessionFile;
  // Extract sessionId from sessionFile path if ctx is sparse
  const sessionId = ctx.sessionId ?? basename(sessionFile, '.jsonl');

  let state = readState(agentDir);

  // IDLE → PENDING
  state = writeState(agentDir, state, 'PENDING', {
    startedAt: new Date().toISOString(),
    oldSessionId: sessionId,
    oldSessionFile: sessionFile,
    triggerCompactionCount: cumulativeCount,
  });

  // Phase 1: ARCHIVE
  const archiveDir = join(agentDir, 'sessions', 'archive');
  if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, `${sessionId}.jsonl`);

  // PENDING → ARCHIVING (write state BEFORE the operation)
  state = writeState(agentDir, state, 'ARCHIVING', { archivePath });

  copyFileSync(sessionFile, archivePath);

  if (!validateArchive(archivePath, sessionFile)) {
    // Rollback: archive invalid, go back to IDLE
    state = writeState(agentDir, state, 'PENDING', { archivePath: null });
    writeState(agentDir, state, 'IDLE', { error: 'Archive validation failed' });
    return;
  }

  // ARCHIVING → ARCHIVED
  state = writeState(agentDir, state, 'ARCHIVED', {});

  // Phase 2: RESET + INJECT
  rotatePhase2(config, ctx, agentDir, state);
}

function rotatePhase2(
  config: RotationConfig,
  ctx: Partial<GatewayContext>,
  agentDir: string,
  state: RotationState,
): void {
  const payload = buildInjectionPayload(config, ctx, agentDir, state);
  const injectionMessage = formatInjectionMessage(payload);

  // Write injection content to a pickup file for OpenClaw
  const injectionPath = join(agentDir, 'rotation-injection.md');
  writeFileSync(injectionPath, injectionMessage, 'utf-8');

  const newSessionId = `rotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // ARCHIVED → INJECTED
  state = writeState(agentDir, state, 'INJECTED', {
    newSessionId,
    injectedTokensEstimate: payload.estimatedTokens,
  });

  finishRotation(agentDir, state, config);
}

function finishRotation(agentDir: string, state: RotationState, config: RotationConfig): void {
  // Record in history
  const entry: RotationHistoryEntry = {
    rotatedAt: new Date().toISOString(),
    oldSessionId: state.oldSessionId ?? 'unknown',
    newSessionId: state.newSessionId ?? 'unknown',
    triggerCompactionCount: state.triggerCompactionCount ?? 0,
    injectedTokensEstimate: state.injectedTokensEstimate ?? 0,
  };
  const history = [...state.rotationHistory, entry];

  // INJECTED → COOLDOWN
  const cooldownUntil = new Date(Date.now() + config.cooldown.minMinutes * 60_000).toISOString();
  writeState(agentDir, state, 'COOLDOWN', {
    cooldownUntil,
    rotationHistory: history,
    error: null,
  });
}

// ---------------------------------------------------------------------------
// Injection Payload Assembly
// ---------------------------------------------------------------------------

export function buildInjectionPayload(
  config: RotationConfig,
  ctx: Partial<GatewayContext>,
  agentDir: string,
  state: RotationState,
): InjectionPayload {
  // Use workspaceDir from ctx with fallback
  const workspaceDir = ctx.workspaceDir ?? join(agentDir, 'workspace');

  const memoryPath = join(workspaceDir, 'MEMORY.md');
  let longTermMemory = readFileOrEmpty(memoryPath);

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  let todayLog = readFileOrEmpty(join(workspaceDir, 'memory', `${today}.md`));
  let yesterdayLog = readFileOrEmpty(join(workspaceDir, 'memory', `${yesterday}.md`));

  const sessionFile = state.oldSessionFile ?? '';
  let messagePairs = extractRecentMessages(sessionFile, config.recentMessagePairs);

  // Exponential backoff: reduce budget on consecutive rotations
  const backoffMultiplier = getBackoffMultiplier(state, config);
  // Use config.contextWindow instead of ctx.contextWindow
  const tokenBudget = Math.floor(config.contextWindow * config.injectionBudgetPercent * backoffMultiplier);

  const metadata: RotationMetadata = {
    rotationNumber: state.rotationHistory.length + 1,
    reason: `compactionCount reached ${state.triggerCompactionCount}`,
    previousSessionId: state.oldSessionId ?? 'unknown',
    archivePath: state.archivePath ?? 'unknown',
    compactionCount: state.triggerCompactionCount ?? 0,
  };

  // Estimate and truncate in priority order
  let total = estimatePayloadTokens(longTermMemory, todayLog, yesterdayLog, messagePairs, metadata);

  if (total > tokenBudget && yesterdayLog) {
    yesterdayLog = '';
    total = estimatePayloadTokens(longTermMemory, todayLog, yesterdayLog, messagePairs, metadata);
  }

  if (total > tokenBudget && messagePairs.length > 3) {
    messagePairs = messagePairs.slice(-3);
    total = estimatePayloadTokens(longTermMemory, todayLog, yesterdayLog, messagePairs, metadata);
  }

  if (total > tokenBudget && longTermMemory) {
    longTermMemory = truncateMemory(longTermMemory);
    total = estimatePayloadTokens(longTermMemory, todayLog, yesterdayLog, messagePairs, metadata);
  }

  if (total > tokenBudget) {
    todayLog = '';
    messagePairs = messagePairs.slice(-1);
    total = estimatePayloadTokens(longTermMemory, todayLog, yesterdayLog, messagePairs, metadata);
  }

  return { longTermMemory, todayLog, yesterdayLog, recentMessages: messagePairs, metadata, estimatedTokens: total };
}

function estimatePayloadTokens(
  memory: string, today: string, yesterday: string, pairs: MessagePair[], meta: RotationMetadata,
): number {
  const messagesText = pairs.map(p => p.user + p.assistant).join('');
  const metaText = JSON.stringify(meta);
  return estimateTokens(memory + today + yesterday + messagesText + metaText);
}

function truncateMemory(text: string): string {
  const lines = text.split('\n');
  const headEnd = Math.floor(lines.length * 0.7);
  const tailStart = Math.floor(lines.length * 0.8);
  const head = lines.slice(0, headEnd);
  const tail = lines.slice(tailStart);
  return [...head, '\n[... truncated for token budget ...]\n', ...tail].join('\n');
}

// ---------------------------------------------------------------------------
// Injection Formatting
// ---------------------------------------------------------------------------

export function formatInjectionMessage(payload: InjectionPayload): string {
  const sections: string[] = [];

  sections.push(`[SYSTEM] This is a fresh session after automatic core rotation.`);
  sections.push(`Previous session was archived after ${payload.metadata.compactionCount} compactions.\n`);
  sections.push(`## Inherited Memory\n`);

  if (payload.longTermMemory) {
    sections.push(`### Long-term Memory (MEMORY.md)\n${payload.longTermMemory}\n`);
  }

  if (payload.todayLog) {
    sections.push(`### Recent Daily Log\n${payload.todayLog}\n`);
  }

  if (payload.yesterdayLog) {
    sections.push(`### Yesterday's Daily Log\n${payload.yesterdayLog}\n`);
  }

  if (payload.recentMessages.length > 0) {
    sections.push(`### Recent Conversation (last ${payload.recentMessages.length} exchanges)`);
    for (const pair of payload.recentMessages) {
      sections.push(`\n**User:** ${pair.user}\n**Assistant:** ${pair.assistant}`);
    }
    sections.push('');
  }

  sections.push(`### Rotation Context`);
  sections.push(`- Rotation #: ${payload.metadata.rotationNumber}`);
  sections.push(`- Reason: ${payload.metadata.reason}`);
  sections.push(`- Previous session: ${payload.metadata.previousSessionId}`);
  sections.push(`- Archive: ${payload.metadata.archivePath}`);
  sections.push('');
  sections.push('Continue serving the user based on this context.');

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Token Estimation
// ---------------------------------------------------------------------------

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// State Machine Persistence
// ---------------------------------------------------------------------------

export function readState(agentDir: string): RotationState {
  const statePath = join(agentDir, 'rotation-state.json');
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return { ...DEFAULT_STATE, updatedAt: new Date().toISOString() };
  }
}

export function writeState(
  agentDir: string,
  currentState: RotationState,
  newStateName: RotationStateName,
  updates: Partial<RotationState>,
): RotationState {
  const allowed = VALID_TRANSITIONS[currentState.state];
  if (!allowed.includes(newStateName)) {
    throw new Error(`Invalid state transition: ${currentState.state} → ${newStateName}`);
  }

  const newState: RotationState = {
    ...currentState,
    ...updates,
    state: newStateName,
    updatedAt: new Date().toISOString(),
  };

  const statePath = join(agentDir, 'rotation-state.json');
  const tmpPath = statePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(newState, null, 2), 'utf-8');
  renameSync(tmpPath, statePath);

  return newState;
}

/**
 * Update state fields without FSM transition check.
 * Used for updating cumulativeCompactionCount without changing state.
 */
export function patchState(
  agentDir: string,
  currentState: RotationState,
  updates: Partial<RotationState>,
): RotationState {
  const newState: RotationState = {
    ...currentState,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const statePath = join(agentDir, 'rotation-state.json');
  const tmpPath = statePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(newState, null, 2), 'utf-8');
  renameSync(tmpPath, statePath);

  return newState;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isInCooldown(state: RotationState, config: RotationConfig, currentCompactionCount?: number): boolean {
  if (state.cooldownUntil && new Date(state.cooldownUntil) > new Date()) return true;

  if (state.rotationHistory.length === 0) return false;

  const last = state.rotationHistory[state.rotationHistory.length - 1];
  const msSinceLast = Date.now() - new Date(last.rotatedAt).getTime();
  if (msSinceLast < config.cooldown.minMinutes * 60_000) return true;

  // Check compactions since last rotation
  if (currentCompactionCount !== undefined) {
    const delta = currentCompactionCount - last.triggerCompactionCount;
    if (delta < config.cooldown.minCompactions) return true;
  }

  return false;
}

export function checkCircuitBreaker(state: RotationState, config: RotationConfig): boolean {
  const windowStart = Date.now() - config.circuitBreaker.windowMinutes * 60_000;
  const recentRotations = state.rotationHistory.filter(
    (h) => new Date(h.rotatedAt).getTime() > windowStart,
  );
  return recentRotations.length < config.circuitBreaker.maxRotations;
}

/**
 * Exponential backoff: consecutive rotations within the circuit breaker window
 * progressively reduce injection budget (15% -> ~10% -> ~5%).
 */
export function getBackoffMultiplier(state: RotationState, config: RotationConfig): number {
  const windowStart = Date.now() - config.circuitBreaker.windowMinutes * 60_000;
  const consecutiveRecent = state.rotationHistory.filter(
    (h) => new Date(h.rotatedAt).getTime() > windowStart,
  ).length;

  if (consecutiveRecent === 0) return 1.0;
  if (consecutiveRecent === 1) return 0.67;  // ~10% effective budget
  return 0.33;                                // ~5% effective budget
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function readFileOrEmpty(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

export function extractRecentMessages(sessionFile: string, count: number): MessagePair[] {
  if (!sessionFile) return [];
  const content = readFileOrEmpty(sessionFile);
  if (!content) return [];

  const lines = content.trim().split('\n');
  const pairs: MessagePair[] = [];

  // Parse JSONL from end, extract user/assistant pairs
  let pendingAssistant: string | null = null;
  for (let i = lines.length - 1; i >= 0 && pairs.length < count; i--) {
    try {
      const msg = JSON.parse(lines[i]);
      if (msg.role === 'assistant' && !pendingAssistant) {
        pendingAssistant = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      } else if (msg.role === 'user' && pendingAssistant) {
        const userContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        pairs.unshift({ user: userContent, assistant: pendingAssistant });
        pendingAssistant = null;
      }
    } catch {
      continue;
    }
  }

  return pairs;
}

export function validateArchive(archivePath: string, originalPath: string): boolean {
  if (!existsSync(archivePath)) return false;

  try {
    const archiveContent = readFileSync(archivePath, 'utf-8');
    const archiveLines = archiveContent.trim().split('\n').filter(Boolean);
    if (archiveLines.length === 0) return false;

    // First line must be valid JSON
    JSON.parse(archiveLines[0]);
    // Last line must be valid JSON
    JSON.parse(archiveLines[archiveLines.length - 1]);

    // Line count must match original
    const originalContent = readFileSync(originalPath, 'utf-8');
    const originalLines = originalContent.trim().split('\n').filter(Boolean);
    return archiveLines.length === originalLines.length;
  } catch {
    return false;
  }
}

export function hasActiveTasks(sessionFile: string): boolean {
  const content = readFileOrEmpty(sessionFile);
  if (!content) return false;

  const lines = content.trim().split('\n');
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  // Scan the tail (last 50 lines should be sufficient)
  const start = Math.max(0, lines.length - 50);
  for (let i = start; i < lines.length; i++) {
    try {
      const msg = JSON.parse(lines[i]);
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_use' && block.id) {
            toolUseIds.add(block.id);
          }
        }
      }
      if (msg.role === 'tool' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolResultIds.add(block.tool_use_id);
          }
        }
      }
    } catch {
      continue;
    }
  }

  // If any tool_use ID has no matching tool_result, there's an active task
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) return true;
  }
  return false;
}

// TODO: notifyOnRotation requires channel API access — not available in hook context.
// TODO: sessions.json pointer update assumes OpenClaw picks up rotation-injection.md automatically.
//       If not, rotatePhase2 needs to write the newSessionId into sessions.json directly.

/**
 * Load plugin config. Priority:
 *   1. config.json next to the compiled handler.js (plugin's own directory)
 *   2. openclaw.json plugins.entries["core-rotation"] or plugins["core-rotation"]
 *   3. DEFAULT_CONFIG
 */
function loadConfig(agentDir: string): RotationConfig {
  // 1. Try plugin-local config.json (next to compiled handler.js)
  const localConfigPath = join(__dirname, '..', 'config.json');
  const pluginConfig = tryReadJson(localConfigPath)
    ?? tryReadOpenClawConfig(agentDir)
    ?? {};

  return {
    ...DEFAULT_CONFIG,
    ...pluginConfig,
    cooldown: { ...DEFAULT_CONFIG.cooldown, ...pluginConfig.cooldown },
    circuitBreaker: { ...DEFAULT_CONFIG.circuitBreaker, ...pluginConfig.circuitBreaker },
  };
}

function tryReadJson(filePath: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function tryReadOpenClawConfig(agentDir: string): Record<string, any> | null {
  // agentDir could be ~/.openclaw/agents/{id} or ~/.openclaw/agents/{id}/agent
  // Try both levels to find openclaw.json
  const candidates = [
    join(dirname(dirname(agentDir)), 'openclaw.json'),
    join(dirname(dirname(dirname(agentDir))), 'openclaw.json'),
  ];
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) candidates.push(join(home, '.openclaw', 'openclaw.json'));

  for (const p of candidates) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
      const cfg = raw?.plugins?.entries?.['core-rotation'] ?? raw?.plugins?.['core-rotation'];
      if (cfg && typeof cfg === 'object') return cfg;
    } catch {
      continue;
    }
  }
  return null;
}
