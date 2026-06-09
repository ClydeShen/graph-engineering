/**
 * Worker 4-phase lifecycle state machine + Knapsack failure bifurcation.
 *
 * Phases: Initializing → Processing → Writing → Terminated
 *
 * Key invariants:
 *  1. graph.write() is REJECTED during Processing phase (throw LifecycleViolationError)
 *  2. LLM results stay in memory until Writing phase
 *  3. Knapsack failure bifurcation: size-cause → OOM chain; load-cause → re-queue ≤3 then OOM
 *  4. Per-tool-result write timing: state-changing results written immediately after tool returns
 *
 * @see ADR 27 — Worker lifecycle state machine
 * @see ADR 36 — Per-tool-result write timing, crash safety
 */

import type { Worker, WorkerExecutionContext } from './worker.abstract.js';
import type { GraphHandle } from './graph-handle.js';
import type { GraphWriteEvent, WriteResult } from '@shared/types.js';

/** Four lifecycle phases in strict order. */
export type LifecyclePhase = 'Initializing' | 'Processing' | 'Writing' | 'Terminated';

/** Thrown when graph.write() is attempted during the Processing phase. */
export class LifecycleViolationError extends Error {
  constructor(phase: LifecyclePhase) {
    super(`LifecycleViolationError: graph.write() is forbidden during '${phase}' phase`);
    this.name = 'LifecycleViolationError';
  }
}

/**
 * Classify a Worker failure cause for Knapsack bifurcation.
 *
 * - 'size': context is too large to fit — escalate to OOM 3-tier chain immediately
 * - 'load': transient resource/load issue — re-queue up to MAX_LOAD_REQUEUE times
 *
 * @see ADR 27 §Knapsack failure bifurcation
 */
export function classifyKnapsackFailure(err: Error): 'size' | 'load' {
  const msg = err.message.toLowerCase();
  // Size indicators: context window overflow, token budget exceeded
  if (
    msg.includes('context_length_exceeded') ||
    msg.includes('context window') ||
    msg.includes('token') ||
    msg.includes('too large') ||
    msg.includes('max_tokens') ||
    msg.includes('oom') ||
    (err as { code?: string }).code === 'context_length_exceeded'
  ) {
    return 'size';
  }
  // Default: load-caused (transient, retryable)
  return 'load';
}

/** Maximum load-cause re-queue attempts before escalating to OOM chain. */
export const MAX_LOAD_REQUEUE = 3;

/**
 * Write a tool result immediately after a state-changing tool returns.
 * Uses ON CONFLICT DO NOTHING for crash safety — graph contains all completed writes
 * even if Worker dies mid-execution. (ADR 36 D-9)
 *
 * Read-only tool results (e.g. list_files) may be omitted at Worker author's discretion.
 *
 * @param graph  The Worker's GraphHandle (write() allowed in Writing phase only)
 * @param event  The GraphWriteEvent to append
 */
export async function writeToolResult(
  graph: GraphHandle,
  event: GraphWriteEvent,
): Promise<WriteResult> {
  // Delegates to occWrite via graph.write() which uses ON CONFLICT DO NOTHING
  return graph.write(event);
}

/**
 * Phase-guarded GraphHandle wrapper.
 * Wraps a real GraphHandle and throws LifecycleViolationError if write()
 * is called while phase === 'Processing'.
 */
export class PhaseGuardedHandle implements GraphHandle {
  private phase: LifecyclePhase = 'Initializing';
  private readonly inner: GraphHandle;

  constructor(inner: GraphHandle) {
    this.inner = inner;
  }

  get scopeId(): string {
    return this.inner.scopeId;
  }

  setPhase(phase: LifecyclePhase): void {
    this.phase = phase;
  }

  write(event: GraphWriteEvent): Promise<WriteResult> {
    if (this.phase === 'Processing') {
      throw new LifecycleViolationError(this.phase);
    }
    return this.inner.write(event);
  }

  getVersionByHash(scopeId: string, versionHash: string) {
    return this.inner.getVersionByHash(scopeId, versionHash);
  }

  getTailVersionHash(scopeId: string) {
    return this.inner.getTailVersionHash(scopeId);
  }

  getEpisodicRecords(scopeId: string, opts?: import('./trail-reader.js').TrailReaderOptions) {
    return this.inner.getEpisodicRecords(scopeId, opts);
  }
}

/** Typed outcome of a Worker lifecycle run. */
export type LifecycleResult = 'done' | 'suspended' | 'exhausted';

/**
 * Run the full 4-phase Worker lifecycle.
 *
 * Wraps the Worker's GraphHandle in a PhaseGuardedHandle to enforce the
 * no-write-during-Processing invariant at runtime.
 *
 * Knapsack failure bifurcation is applied when onRunning throws:
 *  - size-cause → call onFailed, return 'exhausted' immediately
 *  - load-cause → retry up to MAX_LOAD_REQUEUE times; return 'exhausted' when budget is gone
 *
 * @param worker  The Worker instance
 * @param ctx     Execution context (contains the real GraphHandle)
 */
export async function runLifecycle(
  worker: Worker,
  ctx: WorkerExecutionContext,
): Promise<LifecycleResult> {
  const guard = new PhaseGuardedHandle(ctx.graph);
  const guardedCtx: WorkerExecutionContext = { ...ctx, graph: guard };

  // Phase 1: Initializing
  guard.setPhase('Initializing');
  await worker.onScheduled(guardedCtx);

  // Phase 2: Processing — write() is FORBIDDEN; re-queue loop is internalized
  guard.setPhase('Processing');
  let loadAttempt = 0;
  while (true) {
    try {
      await worker.onRunning(guardedCtx);
      break;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const cause = classifyKnapsackFailure(error);

      if (cause === 'size' || loadAttempt >= MAX_LOAD_REQUEUE) {
        guard.setPhase('Writing');
        await worker.onFailed(guardedCtx, error);
        guard.setPhase('Terminated');
        return 'exhausted';
      }

      loadAttempt++;
    }
  }

  // Phase 3: Writing — write() IS permitted
  guard.setPhase('Writing');
  try {
    await worker.onCompleted(guardedCtx);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await worker.onFailed(guardedCtx, error);
  }

  // Phase 4: Terminated
  guard.setPhase('Terminated');
  return 'done';
}
