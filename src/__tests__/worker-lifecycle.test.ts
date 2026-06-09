/**
 * Worker Lifecycle Tests — REQ-12, REQ-13
 *
 * Verifies:
 * 1. write() during Processing phase is rejected (LifecycleViolationError)
 * 2. write() during Writing phase succeeds
 * 3. Load-cause failure retries up to MAX_LOAD_REQUEUE+1 times then returns 'exhausted'
 * 4. Size-cause failure returns 'exhausted' immediately without retry
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
    getVersionByHash: vi.fn().mockResolvedValue(null),
    getTailVersionHash: vi.fn().mockResolvedValue('0'.repeat(64)),
    getEpisodicRecords: vi.fn().mockResolvedValue([]),
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

    const result = await runLifecycle(worker, ctx);
    expect(result).toBe('exhausted');
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

    const result = await runLifecycle(worker, ctx);
    expect(result).toBe('done');
    expect(graph.write).toHaveBeenCalledTimes(1);
  });
});

describe('Knapsack failure bifurcation', () => {
  it('size-cause failure returns exhausted immediately without retry', async () => {
    const sizeError = new Error('context_length_exceeded: too many tokens');

    class SizeFailWorker extends Worker {
      callCount = 0;
      async onScheduled(_ctx: WorkerExecutionContext) {}
      async onRunning(_ctx: WorkerExecutionContext) { this.callCount++; throw sizeError; }
      async onCompleted(_ctx: WorkerExecutionContext) {}
      async onFailed(_ctx: WorkerExecutionContext, _err: Error) {}
      async onConflicted(_ctx: WorkerExecutionContext) {}
    }

    const graph = makeMockGraphHandle();
    const ctx = makeCtx(graph);
    const worker = new SizeFailWorker();

    const result = await runLifecycle(worker, ctx);
    expect(result).toBe('exhausted');
    expect(worker.callCount).toBe(1); // no retry on size-cause
  });

  it('load-cause failure retries MAX_LOAD_REQUEUE+1 times then returns exhausted', async () => {
    const loadError = new Error('connection timeout');

    class LoadFailWorker extends Worker {
      callCount = 0;
      async onScheduled(_ctx: WorkerExecutionContext) {}
      async onRunning(_ctx: WorkerExecutionContext) { this.callCount++; throw loadError; }
      async onCompleted(_ctx: WorkerExecutionContext) {}
      async onFailed(_ctx: WorkerExecutionContext, _err: Error) {}
      async onConflicted(_ctx: WorkerExecutionContext) {}
    }

    const graph = makeMockGraphHandle();
    const ctx = makeCtx(graph);
    const worker = new LoadFailWorker();

    const result = await runLifecycle(worker, ctx);
    expect(result).toBe('exhausted');
    expect(worker.callCount).toBe(MAX_LOAD_REQUEUE + 1);
  });

  it('success after transient load failure returns done', async () => {
    const loadError = new Error('connection timeout');
    let callCount = 0;

    class FlakyWorker extends Worker {
      async onScheduled(_ctx: WorkerExecutionContext) {}
      async onRunning(_ctx: WorkerExecutionContext) {
        callCount++;
        if (callCount < 2) throw loadError; // fail once, then succeed
      }
      async onCompleted(_ctx: WorkerExecutionContext) {}
      async onFailed(_ctx: WorkerExecutionContext, _err: Error) {}
      async onConflicted(_ctx: WorkerExecutionContext) {}
    }

    const graph = makeMockGraphHandle();
    const ctx = makeCtx(graph);
    const worker = new FlakyWorker();

    const result = await runLifecycle(worker, ctx);
    expect(result).toBe('done');
    expect(callCount).toBe(2); // failed once, succeeded on second attempt
  });

  it('classifyKnapsackFailure identifies size vs load', () => {
    expect(classifyKnapsackFailure(new Error('context_length_exceeded'))).toBe('size');
    expect(classifyKnapsackFailure(new Error('context window overflow'))).toBe('size');
    expect(classifyKnapsackFailure(new Error('too large for model'))).toBe('size');
    expect(classifyKnapsackFailure(new Error('connection timeout'))).toBe('load');
    expect(classifyKnapsackFailure(new Error('rate limit hit'))).toBe('load');
  });
});
