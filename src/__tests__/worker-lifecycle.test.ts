/**
 * Worker Lifecycle Tests — REQ-12, REQ-13
 *
 * Verifies:
 * 1. write() during Processing phase is rejected (LifecycleViolationError)
 * 2. write() during Writing phase succeeds
 * 3. Load-cause failure re-queues up to MAX_LOAD_REQUEUE (3), then escalates
 * 4. Size-cause failure escalates immediately without re-queue
 */

import { describe, it, expect, vi } from 'vitest';
import type { WorkerExecutionContext } from '../../packages/workers/src/base/worker.abstract.js';
import { Worker } from '../../packages/workers/src/base/worker.abstract.js';
import {
  runLifecycle,
  LifecycleViolationError,
  classifyKnapsackFailure,
  MAX_LOAD_REQUEUE,
} from '../../packages/workers/src/base/lifecycle.js';
import type { GraphHandle } from '../../packages/workers/src/base/graph-handle.js';
import type { WriteResult } from '../../packages/shared/src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockGraphHandle(): GraphHandle {
  return {
    scopeId: 'test-scope-001',
    write: vi.fn().mockResolvedValue({
      version_hash: 'abc'.repeat(21) + 'a',
      event_type: 'task_spawned',
      occ_result: 'won',
    } satisfies WriteResult),
    query: vi.fn().mockResolvedValue([]),
  };
}

function makeCtx(graph: GraphHandle): WorkerExecutionContext {
  return {
    scopeId: 'test-scope-001',
    entityId: 'entity-001',
    currentVersionHash: '0'.repeat(64),
    graph,
    input: {},
  };
}

// ── No-op Worker subclass ─────────────────────────────────────────────────────

class NoopWorker extends Worker {
  async onScheduled(_ctx: WorkerExecutionContext) {}
  async onRunning(_ctx: WorkerExecutionContext) {}
  async onCompleted(_ctx: WorkerExecutionContext) {}
  async onFailed(_ctx: WorkerExecutionContext, _err: Error) {}
  async onConflicted(_ctx: WorkerExecutionContext) {}
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Worker lifecycle — phase enforcement', () => {
  it('write() during Processing phase throws LifecycleViolationError', async () => {
    let caughtError: Error | null = null;

    class WriteDuringProcessingWorker extends Worker {
      async onScheduled(_ctx: WorkerExecutionContext) {}
      async onRunning(ctx: WorkerExecutionContext) {
        // Attempt to write during Processing — should throw
        try {
          await ctx.graph.write({
            scope_id: ctx.scopeId,
            entity_id: ctx.entityId,
            event_type: 'task_spawned',
            predecessor_hash: ctx.currentVersionHash,
            canonical_json_text: '{}',
          });
        } catch (e) {
          caughtError = e as Error;
          throw e; // re-throw so lifecycle sees the failure
        }
      }
      async onCompleted(_ctx: WorkerExecutionContext) {}
      async onFailed(_ctx: WorkerExecutionContext, _err: Error) {}
      async onConflicted(_ctx: WorkerExecutionContext) {}
    }

    const graph = makeMockGraphHandle();
    const ctx = makeCtx(graph);
    const worker = new WriteDuringProcessingWorker();

    await expect(runLifecycle(worker, ctx)).rejects.toThrow();
    expect(caughtError).toBeInstanceOf(LifecycleViolationError);
    expect((caughtError as unknown as LifecycleViolationError).message).toContain('Processing');
    // The real graph.write() must NOT have been called
    expect(graph.write).not.toHaveBeenCalled();
  });

  it('write() during Writing phase succeeds', async () => {
    class WriteInCompletedWorker extends Worker {
      async onScheduled(_ctx: WorkerExecutionContext) {}
      async onRunning(_ctx: WorkerExecutionContext) {}
      async onCompleted(ctx: WorkerExecutionContext) {
        // Writing phase — write() is permitted
        await ctx.graph.write({
          scope_id: ctx.scopeId,
          entity_id: ctx.entityId,
          event_type: 'task_spawned',
          predecessor_hash: ctx.currentVersionHash,
          canonical_json_text: '{"result":"ok"}',
        });
      }
      async onFailed(_ctx: WorkerExecutionContext, _err: Error) {}
      async onConflicted(_ctx: WorkerExecutionContext) {}
    }

    const graph = makeMockGraphHandle();
    const ctx = makeCtx(graph);
    const worker = new WriteInCompletedWorker();

    await runLifecycle(worker, ctx);
    expect(graph.write).toHaveBeenCalledTimes(1);
  });
});

describe('Knapsack failure bifurcation', () => {
  it('size-cause failure escalates immediately (no re-queue)', async () => {
    const sizeError = new Error('context_length_exceeded: too many tokens');

    class SizeFailWorker extends Worker {
      async onScheduled(_ctx: WorkerExecutionContext) {}
      async onRunning(_ctx: WorkerExecutionContext) { throw sizeError; }
      async onCompleted(_ctx: WorkerExecutionContext) {}
      async onFailed(_ctx: WorkerExecutionContext, _err: Error) {}
      async onConflicted(_ctx: WorkerExecutionContext) {}
    }

    const graph = makeMockGraphHandle();
    const ctx = makeCtx(graph);
    const worker = new SizeFailWorker();

    const err = await runLifecycle(worker, ctx, 0).catch(e => e) as Error & { knapsackCause: string; escalated: boolean };
    expect(err.knapsackCause).toBe('size');
    expect(err.escalated).toBe(true);
  });

  it('load-cause failure re-queues — does not escalate before MAX_LOAD_REQUEUE', async () => {
    const loadError = new Error('connection timeout');

    class LoadFailWorker extends Worker {
      async onScheduled(_ctx: WorkerExecutionContext) {}
      async onRunning(_ctx: WorkerExecutionContext) { throw loadError; }
      async onCompleted(_ctx: WorkerExecutionContext) {}
      async onFailed(_ctx: WorkerExecutionContext, _err: Error) {}
      async onConflicted(_ctx: WorkerExecutionContext) {}
    }

    const graph = makeMockGraphHandle();
    const ctx = makeCtx(graph);
    const worker = new LoadFailWorker();

    // Attempts 0, 1, 2 should NOT escalate
    for (let attempt = 0; attempt < MAX_LOAD_REQUEUE; attempt++) {
      const err = await runLifecycle(worker, ctx, attempt).catch(e => e) as Error & { knapsackCause: string; escalated: boolean };
      expect(err.knapsackCause).toBe('load');
      expect(err.escalated).toBe(false);
    }
  });

  it('load-cause failure escalates after MAX_LOAD_REQUEUE attempts', async () => {
    const loadError = new Error('connection timeout');

    class LoadFailWorker extends Worker {
      async onScheduled(_ctx: WorkerExecutionContext) {}
      async onRunning(_ctx: WorkerExecutionContext) { throw loadError; }
      async onCompleted(_ctx: WorkerExecutionContext) {}
      async onFailed(_ctx: WorkerExecutionContext, _err: Error) {}
      async onConflicted(_ctx: WorkerExecutionContext) {}
    }

    const graph = makeMockGraphHandle();
    const ctx = makeCtx(graph);
    const worker = new LoadFailWorker();

    // Attempt MAX_LOAD_REQUEUE (=3) should escalate
    const err = await runLifecycle(worker, ctx, MAX_LOAD_REQUEUE).catch(e => e) as Error & { knapsackCause: string; escalated: boolean };
    expect(err.knapsackCause).toBe('load');
    expect(err.escalated).toBe(true);
  });

  it('classifyKnapsackFailure identifies size vs load', () => {
    expect(classifyKnapsackFailure(new Error('context_length_exceeded'))).toBe('size');
    expect(classifyKnapsackFailure(new Error('context window overflow'))).toBe('size');
    expect(classifyKnapsackFailure(new Error('too large for model'))).toBe('size');
    expect(classifyKnapsackFailure(new Error('connection timeout'))).toBe('load');
    expect(classifyKnapsackFailure(new Error('rate limit hit'))).toBe('load');
  });
});
