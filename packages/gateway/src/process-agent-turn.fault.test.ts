/**
 * Fault taxonomy tests (ADR 55 D-1): the ADR-39 lockout fires ONLY on true
 * context overflow; environment faults degrade the turn and the scope stays
 * alive. Mirrors the mock layout of process-agent-turn.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

const checkSuspended = vi.fn();
const checkConvergence = vi.fn();
const writeScopeClosed = vi.fn();
const writeContextOomThrottled = vi.fn();
const occWrite = vi.fn();
const assembleContext = vi.fn();
const makeKnapsackGraph = vi.fn();
const isScopeColdStart = vi.fn();
const buildCapabilityEndorsement = vi.fn();
const memReflect = vi.fn();
const insertWorkingMemory = vi.fn();
const recordTemplateInjection = vi.fn();

vi.mock('./watchdog-sql.js', () => ({
  checkSuspended: (...a: unknown[]) => checkSuspended(...a),
  checkConvergence: (...a: unknown[]) => checkConvergence(...a),
  writeScopeClosed: (...a: unknown[]) => writeScopeClosed(...a),
  writeContextOomThrottled: (...a: unknown[]) => writeContextOomThrottled(...a),
}));
vi.mock('@shared/occ-write', () => ({ occWrite: (...a: unknown[]) => occWrite(...a) }));
vi.mock('@graph/workers/context/assemble', () => ({
  assembleContext: (...a: unknown[]) => assembleContext(...a),
}));
vi.mock('./knapsack-graph.js', () => ({
  makeKnapsackGraph: (...a: unknown[]) => makeKnapsackGraph(...a),
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
vi.mock('@graph/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@graph/shared')>();
  return {
    ...actual,
    isScopeColdStart: (...a: unknown[]) => isScopeColdStart(...a),
    buildCapabilityEndorsement: (...a: unknown[]) => buildCapabilityEndorsement(...a),
  };
});

import { processAgentTurn } from './process-agent-turn.js';

const pool = {} as Pool;
const event = {
  entity_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  event_type: 'task_spawned' as const,
  predecessor_hash: '0'.repeat(64),
  payload: { text: 'hi' },
};

beforeEach(() => {
  vi.clearAllMocks();
  checkSuspended.mockResolvedValue(false);
  checkConvergence.mockResolvedValue({ isConverged: false, noOpenConflicts: true });
  occWrite.mockResolvedValue({ version_hash: 'h1', occ_result: 'won' });
  makeKnapsackGraph.mockResolvedValue({});
  isScopeColdStart.mockResolvedValue(false);
});

describe('processAgentTurn fault taxonomy (ADR 55 D-1)', () => {
  it('environment fault (fetch failed) degrades the turn — scope NOT suspended', async () => {
    assembleContext.mockRejectedValue(new Error('fetch failed'));

    const result = await processAgentTurn(pool, 'scope-1', event, 4096, null);

    expect(result).toMatchObject({ suspended: false, version_hash: 'h1', context: null });
    expect(writeContextOomThrottled).not.toHaveBeenCalled();
  });

  it('transient DB hiccup (ECONNRESET) degrades — scope NOT suspended', async () => {
    assembleContext.mockRejectedValue(new Error('read ECONNRESET'));

    await processAgentTurn(pool, 'scope-1', event, 4096, null);

    expect(writeContextOomThrottled).not.toHaveBeenCalled();
  });

  it('true context overflow still triggers the ADR-39 lockout', async () => {
    assembleContext.mockRejectedValue(new Error('context window exceeded: too many tokens'));

    const result = await processAgentTurn(pool, 'scope-1', event, 4096, null);

    expect(result).toMatchObject({ suspended: false, context: null });
    expect(writeContextOomThrottled).toHaveBeenCalledWith(pool, 'scope-1');
  });

  it('null embedding provider: cold-start turn completes with degraded reflection', async () => {
    assembleContext.mockResolvedValue({ stable: 's', context: [], volatile: '{}' });
    isScopeColdStart.mockResolvedValue(true);
    buildCapabilityEndorsement.mockResolvedValue(null);
    memReflect.mockResolvedValue({ content: '', tokens: 0, proceduralIds: [], degraded: true });

    const result = await processAgentTurn(pool, 'scope-1', event, 4096, null);

    expect(result).toMatchObject({ suspended: false, occ_result: 'won' });
    // memReflect receives the null provider and handles it internally
    expect(memReflect).toHaveBeenCalledWith(pool, null, expect.objectContaining({ trigger_type: 'cold_start' }));
    expect(writeContextOomThrottled).not.toHaveBeenCalled();
  });
});
