/**
 * process-agent-turn.test.ts — Phase 10 production-path logic:
 *   - ADR-21 trigger selection (cold_start > conflict_detected > macro_planning)
 *   - template injection recording (reinforcement-loop write side, migration 013)
 *   - TD-B dedup window for memory_updated (ADR-11 supplement)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

const occWrite = vi.fn();
const checkSuspended = vi.fn();
const checkConvergence = vi.fn();
const writeScopeClosed = vi.fn();
const writeContextOomThrottled = vi.fn();
const assembleContext = vi.fn();
const makeKnapsackGraph = vi.fn();
const isScopeColdStart = vi.fn();
const memReflect = vi.fn();
const insertWorkingMemory = vi.fn();
const recordTemplateInjection = vi.fn();

vi.mock('@shared/occ-write', () => ({ occWrite: (...a: unknown[]) => occWrite(...a) }));
vi.mock('@shared/logger', () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
  LOG_EVENTS: new Proxy({}, { get: (_t, k) => String(k) }),
}));
vi.mock('./watchdog-sql.js', () => ({
  checkSuspended: (...a: unknown[]) => checkSuspended(...a),
  checkConvergence: (...a: unknown[]) => checkConvergence(...a),
  writeScopeClosed: (...a: unknown[]) => writeScopeClosed(...a),
  writeContextOomThrottled: (...a: unknown[]) => writeContextOomThrottled(...a),
}));
vi.mock('@graph/workers/context/assemble', () => ({
  assembleContext: (...a: unknown[]) => assembleContext(...a),
}));
vi.mock('./knapsack-graph.js', () => ({
  makeKnapsackGraph: (...a: unknown[]) => makeKnapsackGraph(...a),
}));
vi.mock('@graph/shared', () => ({
  isScopeColdStart: (...a: unknown[]) => isScopeColdStart(...a),
}));
vi.mock('@graph/workers/memory/reflect.function', () => ({
  memReflect: (...a: unknown[]) => memReflect(...a),
}));
vi.mock('@graph/workers/memory/working-memory', () => ({
  insertWorkingMemory: (...a: unknown[]) => insertWorkingMemory(...a),
}));
vi.mock('@graph/workers/memory/template-injection', () => ({
  recordTemplateInjection: (...a: unknown[]) => recordTemplateInjection(...a),
}));

import { processAgentTurn } from './process-agent-turn.js';

const pool = {} as Pool;
const embed = { embed: vi.fn() };

function makeEvent(eventType: 'task_spawned' | 'memory_updated') {
  return {
    entity_id: '11111111-1111-4111-8111-111111111111',
    event_type: eventType,
    predecessor_hash: '0'.repeat(64),
    payload: { description: 'do the thing' },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  checkSuspended.mockResolvedValue(false);
  occWrite.mockResolvedValue({ version_hash: 'vh-1', occ_result: 'won' });
  checkConvergence.mockResolvedValue({ isConverged: false, noOpenConflicts: false });
  makeKnapsackGraph.mockResolvedValue({});
  assembleContext.mockResolvedValue({
    stable: 's', context: [], volatile: 'v', ccrHashes: [], droppedCount: 0,
  });
  isScopeColdStart.mockResolvedValue(false);
  insertWorkingMemory.mockResolvedValue({ inserted: true });
  memReflect.mockResolvedValue({
    content: 'reflected', tokens: 7,
    sections: { procedural: '', antiPatterns: '', episodic: '', semantic: '' },
    proceduralIds: ['tpl-1'],
  });
  recordTemplateInjection.mockResolvedValue({ recorded: 1 });
});

describe('processAgentTurn — TD-B dedup window', () => {
  it('returns deduplicated without OCC write when the 5-min window blocks a memory_updated', async () => {
    insertWorkingMemory.mockResolvedValue({ inserted: false });
    const result = await processAgentTurn(pool, 'scope-1', makeEvent('memory_updated'), 4000, embed);

    expect(result).toEqual({ suspended: false, deduplicated: true });
    expect(occWrite).not.toHaveBeenCalled();
  });

  it('does not dedup-check task_spawned (lifecycle events are never deduped)', async () => {
    await processAgentTurn(pool, 'scope-1', makeEvent('task_spawned'), 4000, embed);
    expect(insertWorkingMemory).not.toHaveBeenCalled();
    expect(occWrite).toHaveBeenCalledOnce();
  });
});

describe('processAgentTurn — ADR-21 trigger selection', () => {
  it('cold_start has highest precedence and records injected templates', async () => {
    isScopeColdStart.mockResolvedValue(true);
    await processAgentTurn(pool, 'scope-1', makeEvent('task_spawned'), 4000, embed);

    expect(memReflect).toHaveBeenCalledWith(pool, embed, expect.objectContaining({
      trigger_type: 'cold_start',
    }));
    expect(recordTemplateInjection).toHaveBeenCalledWith(pool, 'scope-1', ['tpl-1'], 'cold_start');
  });

  it('demoted OCC result triggers conflict_detected reflection', async () => {
    occWrite.mockResolvedValue({ version_hash: 'vh-1', occ_result: 'demoted' });
    await processAgentTurn(pool, 'scope-1', makeEvent('memory_updated'), 4000, embed);

    expect(memReflect).toHaveBeenCalledWith(pool, embed, expect.objectContaining({
      trigger_type: 'conflict_detected',
    }));
  });

  it('task_spawned (non-cold, won) triggers macro_planning reflection', async () => {
    await processAgentTurn(pool, 'scope-1', makeEvent('task_spawned'), 4000, embed);

    expect(memReflect).toHaveBeenCalledWith(pool, embed, expect.objectContaining({
      trigger_type: 'macro_planning',
    }));
  });

  it('memory_updated (non-cold, won) triggers no reflection at all', async () => {
    await processAgentTurn(pool, 'scope-1', makeEvent('memory_updated'), 4000, embed);
    expect(memReflect).not.toHaveBeenCalled();
    expect(recordTemplateInjection).not.toHaveBeenCalled();
  });

  it('does not record injection when reflect returns no procedural ids', async () => {
    isScopeColdStart.mockResolvedValue(true);
    memReflect.mockResolvedValue({
      content: '', tokens: 0,
      sections: { procedural: '', antiPatterns: '', episodic: '', semantic: '' },
      proceduralIds: [],
    });
    await processAgentTurn(pool, 'scope-1', makeEvent('task_spawned'), 4000, embed);
    expect(recordTemplateInjection).not.toHaveBeenCalled();
  });
});
