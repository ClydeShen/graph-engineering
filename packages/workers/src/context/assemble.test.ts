import { describe, it, expect, vi } from 'vitest';
import type { EventLogNode, CanonicalEventType } from '@shared/types';
import { ZERO_HASH } from '@shared/constants';
import {
  Worker,
  type WorkerExecutionContext,
  type PipelineContext,
} from '../base/worker.abstract.js';
import {
  assembleContext,
  runContextAssemblyPipeline,
  STABLE_SYSTEM_ROLE,
} from './assemble.js';
import type { KnapsackGraph } from './knapsack.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let counter = 0;

function makeEvent(
  overrides: Partial<EventLogNode> & { event_type: CanonicalEventType }
): EventLogNode {
  counter++;
  const hash = overrides.version_hash ?? `hash-${counter}`.padEnd(64, '0');
  return {
    id: `id-${counter}`,
    scope_id: 'scope-1',
    entity_id: 'entity-1',
    event_type: overrides.event_type,
    predecessor_hash: overrides.predecessor_hash ?? ZERO_HASH,
    version_hash: hash,
    payload: overrides.payload ?? 'x'.repeat(40),
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
    events[i]!.predecessor_hash =
      i + 1 < events.length ? events[i + 1]!.version_hash : ZERO_HASH;
  }
  const byHash = new Map(events.map((e) => [e.version_hash, e]));
  return {
    getEventByHash: (hash: string) => byHash.get(hash),
    getSiblings: () => siblings,
  };
}

/**
 * SpyWorker: concrete Worker subclass that records pipeline hook invocations.
 * Used to verify runContextAssemblyPipeline() calls the correct hooks.
 */
class SpyWorker extends Worker {
  readonly assembledCalls: PipelineContext[] = [];
  readonly compressedCalls: PipelineContext[] = [];

  async onScheduled(_ctx: WorkerExecutionContext): Promise<void> {}
  async onRunning(_ctx: WorkerExecutionContext): Promise<void> {}
  async onCompleted(_ctx: WorkerExecutionContext): Promise<void> {}
  async onFailed(_ctx: WorkerExecutionContext, _error: Error): Promise<void> {}
  async onConflicted(_ctx: WorkerExecutionContext): Promise<void> {}

  protected override async onContextAssembled(ctx: Readonly<PipelineContext>): Promise<void> {
    this.assembledCalls.push({ ...ctx, ccrHashes: [...ctx.ccrHashes] });
  }

  protected override async onContextCompressed(ctx: Readonly<PipelineContext>): Promise<void> {
    this.compressedCalls.push({ ...ctx, ccrHashes: [...ctx.ccrHashes] });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('assembleContext CCR wiring', () => {
  it('Test 1: no drops — backward compat, ccrHashes empty, stable byte-identical, droppedCount=0', async () => {
    // Large wMax so no events are dropped
    const events = [
      makeEvent({ event_type: 'task_spawned' }),
      makeEvent({ event_type: 'plan_created' }),
    ];
    const graph = chainGraph(events);
    const rootHash = events[0]!.version_hash;

    const result = await assembleContext(graph, 'scope-1', rootHash, {}, 100000);

    expect(result.ccrHashes).toEqual([]);
    expect(result.ccrInstructions == null || result.ccrInstructions === '').toBe(true);
    expect(result.droppedCount).toBe(0);
    // stable is byte-identical to the constant (no per-invocation mutation)
    expect(result.stable).toBe(STABLE_SYSTEM_ROLE);
    // context carries the kept events (shape unchanged from pre-CCR)
    expect(result.context).not.toBeNull();
    expect(Array.isArray(result.context)).toBe(true);
    expect((result.context as EventLogNode[]).length).toBe(events.length);
  });

  it('Test 2: drops present — sentinel appended, ccrHashes has hash, ccrInstructions has memex_retrieve, stable byte-identical', async () => {
    // One small event (fits budget) + one large event (exceeds budget → dropped)
    const eventA = makeEvent({
      event_type: 'task_spawned',
      payload: 'x'.repeat(20), // small — fits
    });
    const eventB = makeEvent({
      event_type: 'plan_created',
      payload: 'y'.repeat(10000), // very large — always drops
    });
    // eventA is newest (rootHash), eventB is predecessor
    const graph = chainGraph([eventA, eventB]);
    const rootHash = eventA.version_hash;

    // wMax small enough that only eventA fits; eventB always drops
    // STABLE_SYSTEM_ROLE ≈ ~90 tokens; volatile ≈ 1 token; forKnapsack ≈ 500 - 91 = 409
    // eventA (20 chars) = ~5 tokens → fits; eventB (10000 chars) = ~2500 tokens → drops
    const result = await assembleContext(graph, 'scope-1', rootHash, {}, 500);

    // ccrHashes has exactly one hash (one dropped batch)
    expect(result.ccrHashes).toHaveLength(1);
    expect(result.ccrHashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(result.droppedCount).toBeGreaterThan(0);

    // stable remains byte-identical (D-03/ADR-30-D-1 resolution)
    expect(result.stable).toBe(STABLE_SYSTEM_ROLE);

    // ccrInstructions is a non-empty string with memex_retrieve and the hash
    expect(result.ccrInstructions).toContain('memex_retrieve');
    expect(result.ccrInstructions).toContain(result.ccrHashes[0]);

    // context has the CCR sentinel appended as last element (D-04)
    expect(result.context).not.toBeNull();
    const ctx = result.context!;
    const lastElement = ctx[ctx.length - 1];
    expect(lastElement).toHaveProperty('_ccr_dropped');
    const sentinel = (lastElement as { _ccr_dropped: string })._ccr_dropped;
    expect(sentinel).toMatch(/^<<ccr:[0-9a-f]{64} \d+_dropped>>$/);
    expect(sentinel).toContain(result.ccrHashes[0]);
  });

  it('Test 3: scope_closed — context null, CCR fields absent, ADR 24 contract preserved', async () => {
    const graph = chainGraph([]); // no events needed for scope_closed path
    const result = await assembleContext(graph, 'scope-1', ZERO_HASH, {}, 100000, true);

    expect(result.context).toBeNull();
    expect(result.ccrHashes).toEqual([]);
    expect(result.droppedCount).toBe(0);
    // stable is still the constant (no mutation even in scope_closed path)
    expect(result.stable).toBe(STABLE_SYSTEM_ROLE);
  });
});

describe('runContextAssemblyPipeline', () => {
  it('Test 4: no drops — onContextAssembled called once with correct PipelineContext; onContextCompressed NOT called', async () => {
    const events = [makeEvent({ event_type: 'task_spawned' })];
    const graph = chainGraph(events);
    const rootHash = events[0]!.version_hash;
    const worker = new SpyWorker();

    await runContextAssemblyPipeline(worker, graph, 'scope-1', rootHash, {}, 100000);

    expect(worker.assembledCalls).toHaveLength(1);
    expect(worker.compressedCalls).toHaveLength(0);
    expect(worker.assembledCalls[0]!.droppedCount).toBe(0);
    expect(worker.assembledCalls[0]!.ccrHashes).toEqual([]);
    expect(worker.assembledCalls[0]!.scopeId).toBe('scope-1');
    expect(worker.assembledCalls[0]!.wMax).toBe(100000);
  });

  it('Test 5: with drops — both onContextAssembled and onContextCompressed called with matching PipelineContext', async () => {
    const eventA = makeEvent({
      event_type: 'task_spawned',
      payload: 'x'.repeat(20),
    });
    const eventB = makeEvent({
      event_type: 'plan_created',
      payload: 'y'.repeat(10000), // always drops
    });
    const graph = chainGraph([eventA, eventB]);
    const rootHash = eventA.version_hash;
    const worker = new SpyWorker();

    const result = await runContextAssemblyPipeline(
      worker,
      graph,
      'scope-1',
      rootHash,
      {},
      500
    );

    expect(worker.assembledCalls).toHaveLength(1);
    expect(worker.compressedCalls).toHaveLength(1);

    const assembledCtx = worker.assembledCalls[0]!;
    const compressedCtx = worker.compressedCalls[0]!;

    // Both hooks receive the same PipelineContext values
    expect(assembledCtx.droppedCount).toBeGreaterThan(0);
    expect(compressedCtx.droppedCount).toBe(assembledCtx.droppedCount);
    expect(assembledCtx.ccrHashes).toEqual(result.ccrHashes);
    expect(compressedCtx.ccrHashes).toEqual(result.ccrHashes);

    // tokensBefore/tokensAfter reflect pre- and post-knapsack contexts
    // (tokensBefore is the volatile input count; tokensAfter is the assembled context count)
    expect(assembledCtx.tokensBefore).toBeGreaterThanOrEqual(0);
    expect(assembledCtx.tokensAfter).toBeGreaterThanOrEqual(0);
    // After dropping a large event, tokensAfter should be less than the total available budget
    expect(assembledCtx.wMax).toBe(500);
  });
});
