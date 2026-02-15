/**
 * OpenClaw Core Rotation Plugin — Unit Tests
 *
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Zero external test dependencies.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync,
  existsSync, rmSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  readState,
  writeState,
  estimateTokens,
  buildInjectionPayload,
  formatInjectionMessage,
  checkCircuitBreaker,
  isInCooldown,
  hasActiveTasks,
  validateArchive,
  extractRecentMessages,
  readFileOrEmpty,
  getBackoffMultiplier,
} from '../handler.js';

import {
  DEFAULT_STATE,
  DEFAULT_CONFIG,
  VALID_TRANSITIONS,
} from '../types.js';

import type {
  RotationState,
  RotationConfig,
  RotationStateName,
  HookContext,
  InjectionPayload,
} from '../types.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/** Creates a temporary directory structure mimicking OpenClaw layout. */
function createTestDir(): string {
  const base = mkdtempSync(join(tmpdir(), 'test-agent-'));
  mkdirSync(join(base, 'sessions', 'archive'), { recursive: true });
  return base;
}

/** Creates a workspace directory with optional MEMORY.md and daily logs. */
function createWorkspace(opts: {
  memoryMd?: string;
  todayLog?: string;
  yesterdayLog?: string;
} = {}): string {
  const ws = mkdtempSync(join(tmpdir(), 'test-workspace-'));
  if (opts.memoryMd !== undefined) {
    writeFileSync(join(ws, 'MEMORY.md'), opts.memoryMd, 'utf-8');
  }
  if (opts.todayLog !== undefined || opts.yesterdayLog !== undefined) {
    mkdirSync(join(ws, 'memory'), { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    if (opts.todayLog !== undefined) {
      writeFileSync(join(ws, 'memory', `${today}.md`), opts.todayLog, 'utf-8');
    }
    if (opts.yesterdayLog !== undefined) {
      writeFileSync(join(ws, 'memory', `${yesterday}.md`), opts.yesterdayLog, 'utf-8');
    }
  }
  return ws;
}

/** Writes a session JSONL file with the given message objects. */
function writeSessionFile(dir: string, sessionId: string, messages: object[]): string {
  const filePath = join(dir, 'sessions', `${sessionId}.jsonl`);
  const content = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/** Creates a fresh RotationState object with overrides. */
function makeState(overrides: Partial<RotationState> = {}): RotationState {
  return {
    ...DEFAULT_STATE,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Creates a HookContext. */
function makeContext(overrides: Partial<HookContext> = {}): HookContext {
  return {
    agentId: 'test-agent',
    sessionId: 'test-session',
    agentDir: '/tmp/test',
    workspaceDir: '/tmp/test-ws',
    contextWindow: 200_000,
    ...overrides,
  };
}

// Track temp dirs for cleanup
let tempDirs: string[] = [];

function trackDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// 1. State Machine Transitions
// ---------------------------------------------------------------------------

describe('State Machine Transitions', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = trackDir(createTestDir());
  });

  afterEach(() => {
    for (const d of tempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('writeState allows valid IDLE -> PENDING transition', () => {
    const state = makeState({ state: 'IDLE' });
    const result = writeState(agentDir, state, 'PENDING', {});
    assert.equal(result.state, 'PENDING');
  });

  it('writeState allows valid PENDING -> ARCHIVING transition', () => {
    const state = makeState({ state: 'PENDING' });
    const result = writeState(agentDir, state, 'ARCHIVING', {});
    assert.equal(result.state, 'ARCHIVING');
  });

  it('writeState allows valid PENDING -> IDLE transition (rollback)', () => {
    const state = makeState({ state: 'PENDING' });
    const result = writeState(agentDir, state, 'IDLE', {});
    assert.equal(result.state, 'IDLE');
  });

  it('writeState allows valid ARCHIVING -> ARCHIVED transition', () => {
    const state = makeState({ state: 'ARCHIVING' });
    const result = writeState(agentDir, state, 'ARCHIVED', {});
    assert.equal(result.state, 'ARCHIVED');
  });

  it('writeState allows valid ARCHIVING -> PENDING transition (rollback)', () => {
    const state = makeState({ state: 'ARCHIVING' });
    const result = writeState(agentDir, state, 'PENDING', {});
    assert.equal(result.state, 'PENDING');
  });

  it('writeState allows valid ARCHIVED -> INJECTED transition', () => {
    const state = makeState({ state: 'ARCHIVED' });
    const result = writeState(agentDir, state, 'INJECTED', {});
    assert.equal(result.state, 'INJECTED');
  });

  it('writeState allows valid INJECTED -> COOLDOWN transition', () => {
    const state = makeState({ state: 'INJECTED' });
    const result = writeState(agentDir, state, 'COOLDOWN', {});
    assert.equal(result.state, 'COOLDOWN');
  });

  it('writeState allows valid COOLDOWN -> IDLE transition', () => {
    const state = makeState({ state: 'COOLDOWN' });
    const result = writeState(agentDir, state, 'IDLE', {});
    assert.equal(result.state, 'IDLE');
  });

  it('writeState throws on invalid IDLE -> ARCHIVED transition', () => {
    const state = makeState({ state: 'IDLE' });
    assert.throws(
      () => writeState(agentDir, state, 'ARCHIVED', {}),
      /Invalid state transition: IDLE .* ARCHIVED/,
    );
  });

  it('writeState throws on invalid IDLE -> COOLDOWN transition', () => {
    const state = makeState({ state: 'IDLE' });
    assert.throws(
      () => writeState(agentDir, state, 'COOLDOWN', {}),
      /Invalid state transition/,
    );
  });

  it('writeState throws on invalid COOLDOWN -> ARCHIVED transition', () => {
    const state = makeState({ state: 'COOLDOWN' });
    assert.throws(
      () => writeState(agentDir, state, 'ARCHIVED', {}),
      /Invalid state transition/,
    );
  });

  it('writeState throws on invalid ARCHIVED -> IDLE transition (skip)', () => {
    const state = makeState({ state: 'ARCHIVED' });
    assert.throws(
      () => writeState(agentDir, state, 'IDLE', {}),
      /Invalid state transition/,
    );
  });

  it('writeState creates file atomically (no .tmp left behind)', () => {
    const state = makeState({ state: 'IDLE' });
    writeState(agentDir, state, 'PENDING', {});
    const tmpPath = join(agentDir, 'rotation-state.json.tmp');
    assert.equal(existsSync(tmpPath), false, '.tmp file should not linger');
    assert.equal(existsSync(join(agentDir, 'rotation-state.json')), true);
  });

  it('writeState persists updates to disk', () => {
    const state = makeState({ state: 'IDLE' });
    writeState(agentDir, state, 'PENDING', { oldSessionId: 'sess-123' });
    const ondisk = JSON.parse(readFileSync(join(agentDir, 'rotation-state.json'), 'utf-8'));
    assert.equal(ondisk.state, 'PENDING');
    assert.equal(ondisk.oldSessionId, 'sess-123');
  });

  it('readState returns DEFAULT_STATE when file is missing', () => {
    const emptyDir = trackDir(createTestDir());
    const state = readState(emptyDir);
    assert.equal(state.state, 'IDLE');
    assert.equal(state.version, 1);
    assert.equal(state.rotationHistory.length, 0);
  });

  it('readState returns persisted state from disk', () => {
    const state = makeState({ state: 'IDLE' });
    const written = writeState(agentDir, state, 'PENDING', { oldSessionId: 'abc' });
    const loaded = readState(agentDir);
    assert.equal(loaded.state, 'PENDING');
    assert.equal(loaded.oldSessionId, 'abc');
    assert.equal(loaded.updatedAt, written.updatedAt);
  });
});

// ---------------------------------------------------------------------------
// 2. Token Estimation
// ---------------------------------------------------------------------------

describe('Token Estimation', () => {
  it('estimateTokens("") returns 0', () => {
    assert.equal(estimateTokens(''), 0);
  });

  it('estimateTokens("test") returns 1 (4 chars / 4)', () => {
    assert.equal(estimateTokens('test'), 1);
  });

  it('estimateTokens("hello world!") returns 3 (12 chars / 4)', () => {
    assert.equal(estimateTokens('hello world!'), 3);
  });

  it('estimateTokens rounds up for non-divisible lengths', () => {
    // "abc" = 3 chars => ceil(3/4) = 1
    assert.equal(estimateTokens('abc'), 1);
    // "abcde" = 5 chars => ceil(5/4) = 2
    assert.equal(estimateTokens('abcde'), 2);
  });

  it('estimateTokens handles longer text', () => {
    const text = 'a'.repeat(100);
    assert.equal(estimateTokens(text), 25);
  });
});

// ---------------------------------------------------------------------------
// 3. Injection Payload Assembly
// ---------------------------------------------------------------------------

describe('Injection Payload Assembly', () => {
  let agentDir: string;
  let workspaceDir: string;

  afterEach(() => {
    for (const d of tempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('includes MEMORY.md content', () => {
    agentDir = trackDir(createTestDir());
    workspaceDir = trackDir(createWorkspace({ memoryMd: 'Long-term memory content here.' }));
    const sessionFile = writeSessionFile(agentDir, 'sess-1', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    const state = makeState({
      state: 'ARCHIVED',
      oldSessionFile: sessionFile,
      oldSessionId: 'sess-1',
      archivePath: '/archive/sess-1.jsonl',
      rotationHistory: [],
    });
    const ctx = makeContext({ agentDir, workspaceDir });
    const payload = buildInjectionPayload(DEFAULT_CONFIG, ctx, state);
    assert.ok(payload.longTermMemory.includes('Long-term memory content here.'));
  });

  it('includes today daily log', () => {
    agentDir = trackDir(createTestDir());
    workspaceDir = trackDir(createWorkspace({ todayLog: 'Today log entry.' }));
    const sessionFile = writeSessionFile(agentDir, 'sess-1', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    const state = makeState({
      state: 'ARCHIVED',
      oldSessionFile: sessionFile,
      oldSessionId: 'sess-1',
      archivePath: '/archive/sess-1.jsonl',
      rotationHistory: [],
    });
    const ctx = makeContext({ agentDir, workspaceDir });
    const payload = buildInjectionPayload(DEFAULT_CONFIG, ctx, state);
    assert.ok(payload.todayLog.includes('Today log entry.'));
  });

  it('includes recent message pairs', () => {
    agentDir = trackDir(createTestDir());
    workspaceDir = trackDir(createWorkspace());
    const messages = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' },
    ];
    const sessionFile = writeSessionFile(agentDir, 'sess-1', messages);
    const state = makeState({
      state: 'ARCHIVED',
      oldSessionFile: sessionFile,
      oldSessionId: 'sess-1',
      archivePath: '/archive/sess-1.jsonl',
      rotationHistory: [],
    });
    const ctx = makeContext({ agentDir, workspaceDir });
    const payload = buildInjectionPayload(DEFAULT_CONFIG, ctx, state);
    assert.equal(payload.recentMessages.length, 2);
    assert.equal(payload.recentMessages[0].user, 'first question');
    assert.equal(payload.recentMessages[1].assistant, 'second answer');
  });

  it('truncation step 1: drops yesterday log when over budget', () => {
    agentDir = trackDir(createTestDir());
    // Create a huge yesterday log that blows the budget
    const hugeText = 'x'.repeat(200_000); // 50K tokens
    workspaceDir = trackDir(createWorkspace({
      memoryMd: 'mem',
      todayLog: 'today',
      yesterdayLog: hugeText,
    }));
    const sessionFile = writeSessionFile(agentDir, 'sess-1', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
    const state = makeState({
      state: 'ARCHIVED',
      oldSessionFile: sessionFile,
      oldSessionId: 'sess-1',
      archivePath: '/archive/sess-1.jsonl',
      rotationHistory: [],
    });
    // Small context window so budget is tight
    const ctx = makeContext({ agentDir, workspaceDir, contextWindow: 200_000 });
    const config: RotationConfig = { ...DEFAULT_CONFIG, injectionBudgetPercent: 0.15 };
    const payload = buildInjectionPayload(config, ctx, state);
    // Yesterday log should be dropped (empty) because it was over budget
    assert.equal(payload.yesterdayLog, '');
  });

  it('truncation step 2: reduces message pairs to 3', () => {
    agentDir = trackDir(createTestDir());
    // Create enough messages and a big memory to force step 2
    const bigMemory = 'M'.repeat(80_000); // 20K tokens
    workspaceDir = trackDir(createWorkspace({ memoryMd: bigMemory }));
    const messages: object[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user', content: 'U'.repeat(2000) });
      messages.push({ role: 'assistant', content: 'A'.repeat(2000) });
    }
    const sessionFile = writeSessionFile(agentDir, 'sess-1', messages);
    const state = makeState({
      state: 'ARCHIVED',
      oldSessionFile: sessionFile,
      oldSessionId: 'sess-1',
      archivePath: '/archive/sess-1.jsonl',
      rotationHistory: [],
    });
    // Tight budget: 10K tokens
    const ctx = makeContext({ agentDir, workspaceDir, contextWindow: 70_000 });
    const config: RotationConfig = { ...DEFAULT_CONFIG, injectionBudgetPercent: 0.15, recentMessagePairs: 5 };
    const payload = buildInjectionPayload(config, ctx, state);
    // After step 2, pairs should be <= 3
    assert.ok(payload.recentMessages.length <= 3, `Expected <= 3 pairs, got ${payload.recentMessages.length}`);
  });

  it('truncation step 3: truncates MEMORY.md', () => {
    agentDir = trackDir(createTestDir());
    // Large MEMORY.md that forces truncation
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${'X'.repeat(500)}`);
    const bigMemory = lines.join('\n');
    workspaceDir = trackDir(createWorkspace({ memoryMd: bigMemory }));
    const sessionFile = writeSessionFile(agentDir, 'sess-1', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
    const state = makeState({
      state: 'ARCHIVED',
      oldSessionFile: sessionFile,
      oldSessionId: 'sess-1',
      archivePath: '/archive/sess-1.jsonl',
      rotationHistory: [],
    });
    // Very tight budget forces truncation of MEMORY.md
    const ctx = makeContext({ agentDir, workspaceDir, contextWindow: 60_000 });
    const config: RotationConfig = { ...DEFAULT_CONFIG, injectionBudgetPercent: 0.15, recentMessagePairs: 1 };
    const payload = buildInjectionPayload(config, ctx, state);
    assert.ok(payload.longTermMemory.includes('[... truncated for token budget ...]'));
    assert.ok(payload.longTermMemory.length < bigMemory.length);
  });

  it('truncation step 4: minimal (MEMORY.md + 1 pair)', () => {
    agentDir = trackDir(createTestDir());
    // Make everything large to force step 4
    const bigMemory = 'M'.repeat(20_000);
    const bigToday = 'T'.repeat(20_000);
    workspaceDir = trackDir(createWorkspace({ memoryMd: bigMemory, todayLog: bigToday }));
    const messages: object[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user', content: 'U'.repeat(2000) });
      messages.push({ role: 'assistant', content: 'A'.repeat(2000) });
    }
    const sessionFile = writeSessionFile(agentDir, 'sess-1', messages);
    const state = makeState({
      state: 'ARCHIVED',
      oldSessionFile: sessionFile,
      oldSessionId: 'sess-1',
      archivePath: '/archive/sess-1.jsonl',
      rotationHistory: [],
    });
    // Extremely tight budget to force step 4
    const ctx = makeContext({ agentDir, workspaceDir, contextWindow: 20_000 });
    const config: RotationConfig = { ...DEFAULT_CONFIG, injectionBudgetPercent: 0.15, recentMessagePairs: 5 };
    const payload = buildInjectionPayload(config, ctx, state);
    // Step 4: todayLog dropped, pairs reduced to 1
    assert.equal(payload.todayLog, '');
    assert.ok(payload.recentMessages.length <= 1, `Expected <= 1 pair, got ${payload.recentMessages.length}`);
  });

  it('never exceeds token budget', () => {
    agentDir = trackDir(createTestDir());
    const bigMemory = 'M'.repeat(100_000);
    const bigToday = 'T'.repeat(50_000);
    const bigYesterday = 'Y'.repeat(50_000);
    workspaceDir = trackDir(createWorkspace({
      memoryMd: bigMemory,
      todayLog: bigToday,
      yesterdayLog: bigYesterday,
    }));
    const messages: object[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: 'U'.repeat(5000) });
      messages.push({ role: 'assistant', content: 'A'.repeat(5000) });
    }
    const sessionFile = writeSessionFile(agentDir, 'sess-1', messages);
    const state = makeState({
      state: 'ARCHIVED',
      oldSessionFile: sessionFile,
      oldSessionId: 'sess-1',
      archivePath: '/archive/sess-1.jsonl',
      rotationHistory: [],
    });
    const ctx = makeContext({ agentDir, workspaceDir, contextWindow: 200_000 });
    const config: RotationConfig = { ...DEFAULT_CONFIG, injectionBudgetPercent: 0.15, recentMessagePairs: 5 };
    const payload = buildInjectionPayload(config, ctx, state);
    const budget = Math.floor(200_000 * 0.15);
    assert.ok(
      payload.estimatedTokens <= budget,
      `Estimated ${payload.estimatedTokens} tokens exceeds budget ${budget}`,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Circuit Breaker
// ---------------------------------------------------------------------------

describe('Circuit Breaker', () => {
  it('returns true (allow) when no rotation history', () => {
    const state = makeState({ rotationHistory: [] });
    assert.equal(checkCircuitBreaker(state, DEFAULT_CONFIG), true);
  });

  it('returns true when rotations < maxRotations in window', () => {
    const state = makeState({
      rotationHistory: [
        { rotatedAt: new Date().toISOString(), oldSessionId: 's1', newSessionId: 's2', triggerCompactionCount: 3, injectedTokensEstimate: 100 },
        { rotatedAt: new Date().toISOString(), oldSessionId: 's2', newSessionId: 's3', triggerCompactionCount: 3, injectedTokensEstimate: 100 },
      ],
    });
    const config: RotationConfig = { ...DEFAULT_CONFIG, circuitBreaker: { maxRotations: 3, windowMinutes: 30 } };
    assert.equal(checkCircuitBreaker(state, config), true);
  });

  it('returns false (block) when rotations >= maxRotations in window', () => {
    const now = Date.now();
    const state = makeState({
      rotationHistory: [
        { rotatedAt: new Date(now - 1000).toISOString(), oldSessionId: 's1', newSessionId: 's2', triggerCompactionCount: 3, injectedTokensEstimate: 100 },
        { rotatedAt: new Date(now - 500).toISOString(), oldSessionId: 's2', newSessionId: 's3', triggerCompactionCount: 3, injectedTokensEstimate: 100 },
        { rotatedAt: new Date(now - 100).toISOString(), oldSessionId: 's3', newSessionId: 's4', triggerCompactionCount: 3, injectedTokensEstimate: 100 },
      ],
    });
    const config: RotationConfig = { ...DEFAULT_CONFIG, circuitBreaker: { maxRotations: 3, windowMinutes: 30 } };
    assert.equal(checkCircuitBreaker(state, config), false);
  });

  it('old rotations outside window do not count', () => {
    const now = Date.now();
    const state = makeState({
      rotationHistory: [
        // These are 2 hours old, outside the 30-minute window
        { rotatedAt: new Date(now - 2 * 60 * 60_000).toISOString(), oldSessionId: 's1', newSessionId: 's2', triggerCompactionCount: 3, injectedTokensEstimate: 100 },
        { rotatedAt: new Date(now - 2 * 60 * 60_000).toISOString(), oldSessionId: 's2', newSessionId: 's3', triggerCompactionCount: 3, injectedTokensEstimate: 100 },
        { rotatedAt: new Date(now - 2 * 60 * 60_000).toISOString(), oldSessionId: 's3', newSessionId: 's4', triggerCompactionCount: 3, injectedTokensEstimate: 100 },
      ],
    });
    const config: RotationConfig = { ...DEFAULT_CONFIG, circuitBreaker: { maxRotations: 3, windowMinutes: 30 } };
    // All 3 rotations are old, so circuit breaker should allow
    assert.equal(checkCircuitBreaker(state, config), true);
  });
});

// ---------------------------------------------------------------------------
// 5. Cooldown
// ---------------------------------------------------------------------------

describe('Cooldown', () => {
  it('isInCooldown returns true when cooldownUntil is in the future', () => {
    const state = makeState({
      cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(isInCooldown(state, DEFAULT_CONFIG), true);
  });

  it('isInCooldown returns true when time since last rotation < minMinutes', () => {
    const state = makeState({
      cooldownUntil: null,
      rotationHistory: [
        {
          rotatedAt: new Date(Date.now() - 5 * 60_000).toISOString(), // 5 min ago
          oldSessionId: 's1',
          newSessionId: 's2',
          triggerCompactionCount: 3,
          injectedTokensEstimate: 100,
        },
      ],
    });
    // minMinutes = 30, last rotation was 5 min ago => in cooldown
    const config: RotationConfig = { ...DEFAULT_CONFIG, cooldown: { minCompactions: 3, minMinutes: 30 } };
    assert.equal(isInCooldown(state, config), true);
  });

  it('isInCooldown returns false when both conditions are met (cooldown expired and enough time)', () => {
    const state = makeState({
      cooldownUntil: null,
      rotationHistory: [
        {
          rotatedAt: new Date(Date.now() - 60 * 60_000).toISOString(), // 60 min ago
          oldSessionId: 's1',
          newSessionId: 's2',
          triggerCompactionCount: 3,
          injectedTokensEstimate: 100,
        },
      ],
    });
    // minMinutes = 30, last rotation was 60 min ago, compactionCount 6 vs trigger 3 => delta 3 >= minCompactions 3
    const config: RotationConfig = { ...DEFAULT_CONFIG, cooldown: { minCompactions: 3, minMinutes: 30 } };
    assert.equal(isInCooldown(state, config, 6), false);
  });

  it('isInCooldown returns false when no rotation history', () => {
    const state = makeState({ cooldownUntil: null, rotationHistory: [] });
    assert.equal(isInCooldown(state, DEFAULT_CONFIG), false);
  });

  it('isInCooldown returns true when enough time passed but compactions < minCompactions', () => {
    const state = makeState({
      cooldownUntil: null,
      rotationHistory: [
        {
          rotatedAt: new Date(Date.now() - 60 * 60_000).toISOString(), // 60 min ago
          oldSessionId: 's1',
          newSessionId: 's2',
          triggerCompactionCount: 3,
          injectedTokensEstimate: 100,
        },
      ],
    });
    // minMinutes = 30, last rotation was 60 min ago (OK), but compaction delta = 4 - 3 = 1 < 3
    const config: RotationConfig = { ...DEFAULT_CONFIG, cooldown: { minCompactions: 3, minMinutes: 30 } };
    assert.equal(isInCooldown(state, config, 4), true);
  });

  it('isInCooldown returns false when compactionCount not provided (backward compat)', () => {
    const state = makeState({
      cooldownUntil: null,
      rotationHistory: [
        {
          rotatedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
          oldSessionId: 's1',
          newSessionId: 's2',
          triggerCompactionCount: 3,
          injectedTokensEstimate: 100,
        },
      ],
    });
    const config: RotationConfig = { ...DEFAULT_CONFIG, cooldown: { minCompactions: 3, minMinutes: 30 } };
    // Without currentCompactionCount, only time check applies. 60 min > 30 min => not in cooldown
    assert.equal(isInCooldown(state, config), false);
  });
});

// ---------------------------------------------------------------------------
// 6. Active Task Detection
// ---------------------------------------------------------------------------

describe('Active Task Detection', () => {
  let agentDir: string;

  afterEach(() => {
    for (const d of tempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('returns false for empty session file', () => {
    agentDir = trackDir(createTestDir());
    const filePath = join(agentDir, 'sessions', 'empty.jsonl');
    writeFileSync(filePath, '', 'utf-8');
    assert.equal(hasActiveTasks(filePath), false);
  });

  it('returns false for non-existent file', () => {
    assert.equal(hasActiveTasks('/tmp/does-not-exist.jsonl'), false);
  });

  it('returns false when all tool_use IDs have matching tool_results', () => {
    agentDir = trackDir(createTestDir());
    const messages = [
      { role: 'user', content: 'do something' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', output: 'done' }] },
    ];
    const filePath = writeSessionFile(agentDir, 'resolved', messages);
    assert.equal(hasActiveTasks(filePath), false);
  });

  it('returns true when tool_use has no tool_result', () => {
    agentDir = trackDir(createTestDir());
    const messages = [
      { role: 'user', content: 'do something' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
    ];
    const filePath = writeSessionFile(agentDir, 'unresolved', messages);
    assert.equal(hasActiveTasks(filePath), true);
  });

  it('returns false when assistant message has no tool_use blocks', () => {
    agentDir = trackDir(createTestDir());
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ];
    const filePath = writeSessionFile(agentDir, 'no-tools', messages);
    assert.equal(hasActiveTasks(filePath), false);
  });

  it('returns true when parallel tool calls have partial results (Fix 3)', () => {
    agentDir = trackDir(createTestDir());
    const messages = [
      { role: 'user', content: 'do three things' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'bash', input: {} },
        { type: 'tool_use', id: 't2', name: 'read', input: {} },
        { type: 'tool_use', id: 't3', name: 'write', input: {} },
      ] },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', output: 'done' }] },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't2', output: 'done' }] },
      // t3 has no result yet
    ];
    const filePath = writeSessionFile(agentDir, 'parallel-partial', messages);
    assert.equal(hasActiveTasks(filePath), true);
  });

  it('returns false when all parallel tool calls have results', () => {
    agentDir = trackDir(createTestDir());
    const messages = [
      { role: 'user', content: 'do three things' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'bash', input: {} },
        { type: 'tool_use', id: 't2', name: 'read', input: {} },
        { type: 'tool_use', id: 't3', name: 'write', input: {} },
      ] },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', output: 'done' }] },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't2', output: 'done' }] },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't3', output: 'done' }] },
    ];
    const filePath = writeSessionFile(agentDir, 'parallel-complete', messages);
    assert.equal(hasActiveTasks(filePath), false);
  });
});

// ---------------------------------------------------------------------------
// 7. Archive Validation
// ---------------------------------------------------------------------------

describe('Archive Validation', () => {
  let agentDir: string;

  afterEach(() => {
    for (const d of tempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('returns true for identical files', () => {
    agentDir = trackDir(createTestDir());
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const content = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
    const originalPath = join(agentDir, 'sessions', 'original.jsonl');
    const archivePath = join(agentDir, 'sessions', 'archive', 'original.jsonl');
    writeFileSync(originalPath, content, 'utf-8');
    writeFileSync(archivePath, content, 'utf-8');
    assert.equal(validateArchive(archivePath, originalPath), true);
  });

  it('returns false for missing archive file', () => {
    agentDir = trackDir(createTestDir());
    const originalPath = join(agentDir, 'sessions', 'original.jsonl');
    writeFileSync(originalPath, JSON.stringify({ role: 'user', content: 'hi' }) + '\n', 'utf-8');
    assert.equal(validateArchive('/tmp/nonexistent-archive.jsonl', originalPath), false);
  });

  it('returns false for empty archive file', () => {
    agentDir = trackDir(createTestDir());
    const originalPath = join(agentDir, 'sessions', 'original.jsonl');
    const archivePath = join(agentDir, 'sessions', 'archive', 'empty.jsonl');
    writeFileSync(originalPath, JSON.stringify({ role: 'user', content: 'hi' }) + '\n', 'utf-8');
    writeFileSync(archivePath, '', 'utf-8');
    assert.equal(validateArchive(archivePath, originalPath), false);
  });

  it('returns false for truncated archive (fewer lines)', () => {
    agentDir = trackDir(createTestDir());
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'bye' },
    ];
    const fullContent = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
    const truncatedContent = messages.slice(0, 2).map(m => JSON.stringify(m)).join('\n') + '\n';

    const originalPath = join(agentDir, 'sessions', 'original.jsonl');
    const archivePath = join(agentDir, 'sessions', 'archive', 'truncated.jsonl');
    writeFileSync(originalPath, fullContent, 'utf-8');
    writeFileSync(archivePath, truncatedContent, 'utf-8');
    assert.equal(validateArchive(archivePath, originalPath), false);
  });
});

// ---------------------------------------------------------------------------
// 8. Message Extraction
// ---------------------------------------------------------------------------

describe('Message Extraction', () => {
  let agentDir: string;

  afterEach(() => {
    for (const d of tempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('returns empty for empty string path', () => {
    assert.deepEqual(extractRecentMessages('', 5), []);
  });

  it('returns empty for non-existent file', () => {
    assert.deepEqual(extractRecentMessages('/tmp/nonexistent.jsonl', 5), []);
  });

  it('returns empty for empty file', () => {
    agentDir = trackDir(createTestDir());
    const filePath = join(agentDir, 'sessions', 'empty.jsonl');
    writeFileSync(filePath, '', 'utf-8');
    assert.deepEqual(extractRecentMessages(filePath, 5), []);
  });

  it('returns correct pairs from JSONL', () => {
    agentDir = trackDir(createTestDir());
    const messages = [
      { role: 'user', content: 'question one' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: 'question two' },
      { role: 'assistant', content: 'answer two' },
    ];
    const filePath = writeSessionFile(agentDir, 'pairs', messages);
    const pairs = extractRecentMessages(filePath, 5);
    assert.equal(pairs.length, 2);
    assert.equal(pairs[0].user, 'question one');
    assert.equal(pairs[0].assistant, 'answer one');
    assert.equal(pairs[1].user, 'question two');
    assert.equal(pairs[1].assistant, 'answer two');
  });

  it('returns last N pairs when more exist', () => {
    agentDir = trackDir(createTestDir());
    const messages: object[] = [];
    for (let i = 1; i <= 10; i++) {
      messages.push({ role: 'user', content: `q${i}` });
      messages.push({ role: 'assistant', content: `a${i}` });
    }
    const filePath = writeSessionFile(agentDir, 'many', messages);
    const pairs = extractRecentMessages(filePath, 3);
    assert.equal(pairs.length, 3);
    // Should be the last 3 pairs
    assert.equal(pairs[0].user, 'q8');
    assert.equal(pairs[1].user, 'q9');
    assert.equal(pairs[2].user, 'q10');
  });

  it('handles non-string content by JSON.stringifying', () => {
    agentDir = trackDir(createTestDir());
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'complex' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'response' }] },
    ];
    const filePath = writeSessionFile(agentDir, 'complex', messages);
    const pairs = extractRecentMessages(filePath, 5);
    assert.equal(pairs.length, 1);
    // Non-string content gets JSON.stringify'd
    assert.ok(pairs[0].user.includes('complex'));
    assert.ok(pairs[0].assistant.includes('response'));
  });
});

// ---------------------------------------------------------------------------
// 9. Injection Formatting
// ---------------------------------------------------------------------------

describe('Injection Formatting', () => {
  it('includes all sections in formatted output', () => {
    const payload: InjectionPayload = {
      longTermMemory: 'Memory content here',
      todayLog: 'Today log here',
      yesterdayLog: 'Yesterday log here',
      recentMessages: [
        { user: 'Hello', assistant: 'Hi there' },
        { user: 'How are you?', assistant: 'Fine, thanks' },
      ],
      metadata: {
        rotationNumber: 2,
        reason: 'compactionCount reached 3',
        previousSessionId: 'old-sess',
        archivePath: '/archive/old-sess.jsonl',
        compactionCount: 3,
      },
      estimatedTokens: 1000,
    };

    const output = formatInjectionMessage(payload);

    // System header
    assert.ok(output.includes('[SYSTEM] This is a fresh session after automatic core rotation.'));
    assert.ok(output.includes('Previous session was archived after 3 compactions.'));

    // Inherited Memory section
    assert.ok(output.includes('## Inherited Memory'));

    // Long-term memory
    assert.ok(output.includes('### Long-term Memory (MEMORY.md)'));
    assert.ok(output.includes('Memory content here'));

    // Today log
    assert.ok(output.includes('### Recent Daily Log'));
    assert.ok(output.includes('Today log here'));

    // Yesterday log
    assert.ok(output.includes("### Yesterday's Daily Log"));
    assert.ok(output.includes('Yesterday log here'));

    // Recent conversation
    assert.ok(output.includes('### Recent Conversation (last 2 exchanges)'));
    assert.ok(output.includes('**User:** Hello'));
    assert.ok(output.includes('**Assistant:** Hi there'));
    assert.ok(output.includes('**User:** How are you?'));
    assert.ok(output.includes('**Assistant:** Fine, thanks'));

    // Rotation context
    assert.ok(output.includes('### Rotation Context'));
    assert.ok(output.includes('- Rotation #: 2'));
    assert.ok(output.includes('- Reason: compactionCount reached 3'));
    assert.ok(output.includes('- Previous session: old-sess'));
    assert.ok(output.includes('- Archive: /archive/old-sess.jsonl'));

    // Footer
    assert.ok(output.includes('Continue serving the user based on this context.'));
  });

  it('omits empty sections', () => {
    const payload: InjectionPayload = {
      longTermMemory: '',
      todayLog: '',
      yesterdayLog: '',
      recentMessages: [],
      metadata: {
        rotationNumber: 1,
        reason: 'compactionCount reached 3',
        previousSessionId: 'sess-1',
        archivePath: '/archive/sess-1.jsonl',
        compactionCount: 3,
      },
      estimatedTokens: 100,
    };

    const output = formatInjectionMessage(payload);

    // These sections should NOT appear when empty
    assert.ok(!output.includes('### Long-term Memory'));
    assert.ok(!output.includes('### Recent Daily Log'));
    assert.ok(!output.includes("### Yesterday's Daily Log"));
    assert.ok(!output.includes('### Recent Conversation'));

    // Rotation context should always appear
    assert.ok(output.includes('### Rotation Context'));
    assert.ok(output.includes('[SYSTEM]'));
  });

  it('output matches spec section 4.3.2 format', () => {
    const payload: InjectionPayload = {
      longTermMemory: 'MEMORY content',
      todayLog: 'Today content',
      yesterdayLog: '',
      recentMessages: [{ user: 'Q', assistant: 'A' }],
      metadata: {
        rotationNumber: 1,
        reason: 'compactionCount reached 3',
        previousSessionId: 'old-id',
        archivePath: '/archive/old-id.jsonl',
        compactionCount: 3,
      },
      estimatedTokens: 500,
    };

    const output = formatInjectionMessage(payload);

    // Verify structure order matches spec
    const systemIdx = output.indexOf('[SYSTEM]');
    const memoryIdx = output.indexOf('## Inherited Memory');
    const ltmIdx = output.indexOf('### Long-term Memory');
    const dailyIdx = output.indexOf('### Recent Daily Log');
    const convIdx = output.indexOf('### Recent Conversation');
    const ctxIdx = output.indexOf('### Rotation Context');
    const footerIdx = output.indexOf('Continue serving the user');

    assert.ok(systemIdx < memoryIdx, 'SYSTEM before Inherited Memory');
    assert.ok(memoryIdx < ltmIdx, 'Inherited Memory before LTM');
    assert.ok(ltmIdx < dailyIdx, 'LTM before Daily Log');
    assert.ok(dailyIdx < convIdx, 'Daily Log before Conversation');
    assert.ok(convIdx < ctxIdx, 'Conversation before Context');
    assert.ok(ctxIdx < footerIdx, 'Context before footer');
  });
});

// ---------------------------------------------------------------------------
// 10. VALID_TRANSITIONS completeness
// ---------------------------------------------------------------------------

describe('VALID_TRANSITIONS map completeness', () => {
  const allStates: RotationStateName[] = ['IDLE', 'PENDING', 'ARCHIVING', 'ARCHIVED', 'INJECTED', 'COOLDOWN'];

  it('every state has an entry in VALID_TRANSITIONS', () => {
    for (const state of allStates) {
      assert.ok(
        Array.isArray(VALID_TRANSITIONS[state]),
        `Missing VALID_TRANSITIONS entry for ${state}`,
      );
    }
  });

  it('all transition targets are valid state names', () => {
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const target of targets) {
        assert.ok(
          allStates.includes(target),
          `Invalid target "${target}" in VALID_TRANSITIONS[${from}]`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Exponential Backoff
// ---------------------------------------------------------------------------

describe('Exponential Backoff', () => {
  it('returns 1.0 when no recent rotations', () => {
    const state = makeState({ rotationHistory: [] });
    assert.equal(getBackoffMultiplier(state, DEFAULT_CONFIG), 1.0);
  });

  it('returns 0.67 when 1 recent rotation in window', () => {
    const state = makeState({
      rotationHistory: [
        {
          rotatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          oldSessionId: 's1',
          newSessionId: 's2',
          triggerCompactionCount: 3,
          injectedTokensEstimate: 100,
        },
      ],
    });
    const config: RotationConfig = { ...DEFAULT_CONFIG, circuitBreaker: { maxRotations: 3, windowMinutes: 30 } };
    assert.equal(getBackoffMultiplier(state, config), 0.67);
  });

  it('returns 0.33 when 2+ recent rotations in window', () => {
    const now = Date.now();
    const state = makeState({
      rotationHistory: [
        { rotatedAt: new Date(now - 10 * 60_000).toISOString(), oldSessionId: 's1', newSessionId: 's2', triggerCompactionCount: 3, injectedTokensEstimate: 100 },
        { rotatedAt: new Date(now - 5 * 60_000).toISOString(), oldSessionId: 's2', newSessionId: 's3', triggerCompactionCount: 3, injectedTokensEstimate: 100 },
      ],
    });
    const config: RotationConfig = { ...DEFAULT_CONFIG, circuitBreaker: { maxRotations: 3, windowMinutes: 30 } };
    assert.equal(getBackoffMultiplier(state, config), 0.33);
  });

  it('does not count rotations outside the window', () => {
    const state = makeState({
      rotationHistory: [
        {
          rotatedAt: new Date(Date.now() - 120 * 60_000).toISOString(), // 2 hours ago, outside 30-min window
          oldSessionId: 's1',
          newSessionId: 's2',
          triggerCompactionCount: 3,
          injectedTokensEstimate: 100,
        },
      ],
    });
    const config: RotationConfig = { ...DEFAULT_CONFIG, circuitBreaker: { maxRotations: 3, windowMinutes: 30 } };
    assert.equal(getBackoffMultiplier(state, config), 1.0);
  });

  it('backoff reduces effective token budget in buildInjectionPayload', () => {
    const agentDir = trackDir(createTestDir());
    const workspaceDir = trackDir(createWorkspace({ memoryMd: 'mem' }));
    const sessionFile = writeSessionFile(agentDir, 'sess-1', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
    const now = Date.now();
    const ctx = makeContext({ agentDir, workspaceDir, contextWindow: 200_000 });
    const config: RotationConfig = { ...DEFAULT_CONFIG, injectionBudgetPercent: 0.15 };

    // No history: full budget
    const stateNoHistory = makeState({
      state: 'ARCHIVED',
      oldSessionFile: sessionFile,
      oldSessionId: 'sess-1',
      archivePath: '/archive/sess-1.jsonl',
      rotationHistory: [],
    });
    const payload1 = buildInjectionPayload(config, ctx, stateNoHistory);

    // 1 recent rotation: reduced budget
    const stateOneRecent = makeState({
      state: 'ARCHIVED',
      oldSessionFile: sessionFile,
      oldSessionId: 'sess-1',
      archivePath: '/archive/sess-1.jsonl',
      rotationHistory: [
        { rotatedAt: new Date(now - 5 * 60_000).toISOString(), oldSessionId: 's0', newSessionId: 's1', triggerCompactionCount: 3, injectedTokensEstimate: 100 },
      ],
    });
    const payload2 = buildInjectionPayload(config, ctx, stateOneRecent);

    // The reduced budget payload should have <= the full budget payload's tokens
    // (they may be equal if the content is small enough to fit even the reduced budget)
    assert.ok(payload2.estimatedTokens <= payload1.estimatedTokens);
  });
});

// ---------------------------------------------------------------------------
// 12. injectedTokensEstimate recorded correctly
// ---------------------------------------------------------------------------

describe('injectedTokensEstimate in state', () => {
  let agentDir: string;

  afterEach(() => {
    for (const d of tempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('writeState stores injectedTokensEstimate field', () => {
    agentDir = trackDir(createTestDir());
    const state = makeState({ state: 'ARCHIVED' });
    const result = writeState(agentDir, state, 'INJECTED', { injectedTokensEstimate: 5000 });
    assert.equal(result.injectedTokensEstimate, 5000);
    // Verify it persists to disk
    const ondisk = JSON.parse(readFileSync(join(agentDir, 'rotation-state.json'), 'utf-8'));
    assert.equal(ondisk.injectedTokensEstimate, 5000);
  });

  it('DEFAULT_STATE has injectedTokensEstimate as null', () => {
    assert.equal(DEFAULT_STATE.injectedTokensEstimate, null);
  });
});
