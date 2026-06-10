import { describe, it, expect } from 'vitest';
import type { EventLogNode, CanonicalEventType } from '@shared/types';
import { ZERO_HASH } from '@shared/constants';
import { knapsackSlice, type KnapsackGraph } from './knapsack.js';

let counter = 0;

function makeEvent(overrides: Partial<EventLogNode> & { event_type: CanonicalEventType }): EventLogNode {
  counter++;
  const hash = overrides.version_hash ?? `hash-${counter}`.padEnd(64, '0');
  return {
    id: `id-${counter}`,
    scope_id: 'scope-1',
    entity_id: 'entity-1',
    event_type: overrides.event_type,
    predecessor_hash: overrides.predecessor_hash ?? ZERO_HASH,
    version_hash: hash,
    payload: overrides.payload ?? 'x'.repeat(40), // ~10 tokens estimate
    status: overrides.status ?? 'archived',
    base_priority: overrides.base_priority ?? 0,
    unlocks_count: overrides.unlocks_count ?? 0,
    spawned_by: overrides.spawned_by ?? null,
    last_active_at: overrides.last_active_at ?? null,
    created_at: overrides.created_at ?? new Date(),
  };
}

/** Build a causal chain: events[0] is newest (rootHash), each predecessor_hash points to the next. */
function chainGraph(events: EventLogNode[], siblings: EventLogNode[] = []): KnapsackGraph {
  for (let i = 0; i < events.length; i++) {
    events[i]!.predecessor_hash = i + 1 < events.length ? events[i + 1]!.version_hash : ZERO_HASH;
  }
  const byHash = new Map(events.map((e) => [e.version_hash, e]));
  return {
    getEventByHash: (hash: string) => byHash.get(hash),
    getSiblings: () => siblings,
  };
}

describe('knapsackSlice', () => {
  it('newest-first (default, no config) — unchanged behavior', async () => {
    const events = [
      makeEvent({ event_type: 'task_spawned' }),
      makeEvent({ event_type: 'plan_created' }),
      makeEvent({ event_type: 'task_spawned' }),
    ];
    const graph = chainGraph(events);
    const rootHash = events[0]!.version_hash;

    const result = await knapsackSlice(graph, 'scope-1', rootHash, 1000);

    expect(result.kept.map((e) => e.id)).toEqual(events.map((e) => e.id));
    expect(result.dropped).toEqual([]);
  });

  it('newest-first explicit strategy — identical to no-config', async () => {
    const events = [
      makeEvent({ event_type: 'task_spawned' }),
      makeEvent({ event_type: 'plan_created' }),
    ];
    const graph = chainGraph(events);
    const rootHash = events[0]!.version_hash;

    const noConfig = await knapsackSlice(graph, 'scope-1', rootHash, 1000);
    const explicit = await knapsackSlice(graph, 'scope-1', rootHash, 1000, { strategy: 'newest-first' });

    expect(explicit.kept.map((e) => e.id)).toEqual(noConfig.kept.map((e) => e.id));
    expect(explicit.dropped).toEqual(noConfig.dropped);
  });

  it('importance-stratified — hoists conflict_detected/scope_closed (Tier 1) ahead of older events', async () => {
    const events = [
      makeEvent({ event_type: 'task_spawned' }), // newest
      makeEvent({ event_type: 'plan_created' }),
      makeEvent({ event_type: 'conflict_detected' }), // Tier 1, but older
      makeEvent({ event_type: 'task_spawned' }), // oldest
    ];
    const graph = chainGraph(events);
    const rootHash = events[0]!.version_hash;

    const result = await knapsackSlice(graph, 'scope-1', rootHash, 1000, {
      strategy: 'importance-stratified',
    });

    // Tier 1 (conflict_detected) is kept first despite being 3rd in causal order.
    expect(result.kept[0]!.event_type).toBe('conflict_detected');
    // All events fit in budget — all kept.
    expect(result.kept).toHaveLength(4);
    expect(result.dropped).toEqual([]);
  });

  it('importance-stratified — collapses consecutive memory_updated runs into one representative entry', async () => {
    const events = [
      makeEvent({ event_type: 'plan_created' }), // newest
      makeEvent({ event_type: 'memory_updated' }), // run start (most recent of run)
      makeEvent({ event_type: 'memory_updated' }),
      makeEvent({ event_type: 'memory_updated' }),
      makeEvent({ event_type: 'memory_updated' }), // run end (oldest of run)
      makeEvent({ event_type: 'task_spawned' }), // oldest
    ];
    const graph = chainGraph(events);
    const rootHash = events[0]!.version_hash;

    const result = await knapsackSlice(graph, 'scope-1', rootHash, 1000, {
      strategy: 'importance-stratified',
    });

    const memoryUpdatedKept = result.kept.filter((e) => e.event_type === 'memory_updated');
    const memoryUpdatedDropped = result.dropped.filter((e) => e.event_type === 'memory_updated');

    // Only one memory_updated entry total across kept+dropped — never all 4.
    expect(memoryUpdatedKept.length + memoryUpdatedDropped.length).toBe(1);
    // The representative is the most-recent (first) of the run.
    if (memoryUpdatedKept.length === 1) {
      expect(memoryUpdatedKept[0]!.id).toBe(events[1]!.id);
    } else {
      expect(memoryUpdatedDropped[0]!.id).toBe(events[1]!.id);
    }
  });

  it('importance-stratified — Tier 1 events placed first even when budget is too small to keep them', async () => {
    const events = [
      makeEvent({ event_type: 'task_spawned' }), // newest
      makeEvent({ event_type: 'scope_closed' }), // Tier 1, but older — large payload
    ];
    // Make the scope_closed payload larger than any feasible budget.
    events[1]!.payload = 'y'.repeat(4000);
    const graph = chainGraph(events);
    const rootHash = events[0]!.version_hash;

    // Budget large enough for the small task_spawned event but too small for scope_closed.
    const result = await knapsackSlice(graph, 'scope-1', rootHash, 5, {
      strategy: 'importance-stratified',
    });

    // scope_closed (Tier 1) is tried first by the greedy loop — and dropped because
    // it exceeds the budget, demonstrating "first in candidates, droppable if oversized".
    expect(result.dropped[0]!.event_type).toBe('scope_closed');
    expect(result.kept).toEqual([]);
  });
});
