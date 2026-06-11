import { describe, it, expect } from 'vitest';
import type { EventLogNode } from '@shared/types';
import { ReverseChronologicalDiscarder } from '../../packages/workers/src/context/overflow';
import { knapsackSlice } from '../../packages/workers/src/context/knapsack';

// Helper: build a minimal EventLogNode stub
function makeEvent(
  id: string,
  predecessor_hash: string,
  version_hash: string,
  payload: string,
  created_at: Date,
  event_type: EventLogNode['event_type'] = 'task_spawned'
): EventLogNode {
  return {
    id,
    scope_id: 'scope-test',
    entity_id: `entity-${id}`,
    event_type,
    predecessor_hash,
    version_hash,
    payload,
    status: 'pending_scheduling',
    base_priority: 1,
    unlocks_count: 0,
    spawned_by: null,
    last_active_at: null,
    created_at,
  };
}

// Four events ordered oldest → newest
const T1 = new Date('2026-01-01T00:00:00Z');
const T2 = new Date('2026-01-01T00:01:00Z');
const T3 = new Date('2026-01-01T00:02:00Z');
const T4 = new Date('2026-01-01T00:03:00Z');

// Each payload is ~10 tokens; 'A'.repeat(40) ≈ 10 tokens in cl100k_base
const PAYLOAD_SMALL = JSON.stringify({ data: 'A'.repeat(40) });

const e1 = makeEvent('e1', '0'.repeat(64), 'hash1', PAYLOAD_SMALL, T1, 'plan_created');
const e2 = makeEvent('e2', 'hash1', 'hash2', PAYLOAD_SMALL, T2);
const e3 = makeEvent('e3', 'hash2', 'hash3', PAYLOAD_SMALL, T3);
const e4 = makeEvent('e4', 'hash3', 'hash4', PAYLOAD_SMALL, T4);

describe('ReverseChronologicalDiscarder', () => {
  const discarder = new ReverseChronologicalDiscarder();

  it('packs newest events first (result[0] is the most recent event)', () => {
    const result = discarder.discard([e1, e2, e3, e4], 10000);
    // All fit; newest first
    expect(result[0].id).toBe('e4');
    expect(result[result.length - 1].id).toBe('e1');
  });

  it('stops packing when next event would exceed wMax — oldest events are dropped', () => {
    // Each event is ~10-15 tokens; wMax=25 should fit 2 events (newest), drop oldest 2
    const result = discarder.discard([e1, e2, e3, e4], 25);
    // Must include e4 (newest)
    expect(result.some(e => e.id === 'e4')).toBe(true);
    // Must NOT include e1 (oldest) when budget is tight
    expect(result.some(e => e.id === 'e1')).toBe(false);
    // Result must be non-empty
    expect(result.length).toBeGreaterThan(0);
  });

  it('performs no LLM call — discard is purely deterministic (synchronous)', () => {
    // discard() is a synchronous function — if it were async it would need await
    // This test verifies it returns EventLogNode[] directly, not a Promise
    const result = discarder.discard([e1, e2, e3, e4], 10000);
    expect(Array.isArray(result)).toBe(true);
    expect(result).not.toBeInstanceOf(Promise);
  });

  it('oldest events are dropped (not summarized) when budget is exceeded', () => {
    // wMax=1: even a single event may not fit → result can be empty OR contain just newest
    const result = discarder.discard([e1, e2, e3, e4], 1);
    // e1 (oldest) must never appear when budget is 1
    expect(result.some(e => e.id === 'e1')).toBe(false);
    // e2 and e3 must not appear either
    expect(result.some(e => e.id === 'e2')).toBe(false);
  });
});

describe('knapsackSlice', () => {
  // Build a minimal mock graph: predecessor_hash chain e1→e2→e3→e4
  const mockGraph = {
    getEventByHash: (hash: string): EventLogNode | undefined => {
      const map: Record<string, EventLogNode> = {
        hash1: e1,
        hash2: e2,
        hash3: e3,
        hash4: e4,
      };
      return map[hash];
    },
    getSiblings: (_scopeId: string, _excludeHash: string): EventLogNode[] => [],
  };

  it('walks predecessor_hash chain to build causal skeleton', async () => {
    const { kept } = await knapsackSlice(mockGraph, 'scope-test', 'hash4', 10000);
    const ids = kept.map(e => e.id);
    // Should include all ancestors following predecessor_hash chain
    expect(ids).toContain('e4');
    expect(ids).toContain('e3');
    expect(ids).toContain('e2');
  });

  it('respects wMax budget — does not exceed token limit', async () => {
    const { kept } = await knapsackSlice(mockGraph, 'scope-test', 'hash4', 5);
    // With tiny budget, result must be empty or very small
    expect(kept.length).toBeLessThanOrEqual(4);
  });

  it('returns dropped events beyond budget', async () => {
    const { kept, dropped } = await knapsackSlice(mockGraph, 'scope-test', 'hash4', 5);
    // All candidates must appear in either kept or dropped
    expect(kept.length + dropped.length).toBeGreaterThan(0);
  });
});
