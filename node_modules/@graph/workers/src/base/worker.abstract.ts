/**
 * Worker abstract base class — full graph access for business logic Workers.
 *
 * Workers receive GraphHandle (has write()). They are the only actors authorized
 * to append events to the execution_event_log.
 *
 * Lifecycle: Initializing → Processing → Writing → Terminated
 * ZERO persistent writes during Processing phase. (ADR 27)
 *
 * @see ADR 27 — Worker lifecycle state machine
 * @see ADR 35 — Worker/Tool capability boundary
 * @see ADR 36 — Per-tool-result write timing
 */

import type { GraphHandle } from './graph-handle.js';

/**
 * Execution context passed to all Worker lifecycle hooks.
 * graph is GraphHandle — Workers CAN call graph.write() during Writing phase only.
 */
export interface WorkerExecutionContext {
  scopeId: string;
  entityId: string;
  currentVersionHash: string;
  /** Full read/write graph access. write() MUST only be called during Writing phase. */
  graph: GraphHandle;
  /** Arbitrary typed input payload for this Worker invocation. */
  input: unknown;
}

/**
 * Abstract Worker base class.
 *
 * Subclasses must implement all lifecycle hooks. The runLifecycle() driver
 * in lifecycle.ts calls these in order and enforces write timing rules.
 *
 * Hook semantics:
 *  - onScheduled:  called when Worker is first selected from the queue (Initializing phase)
 *  - onRunning:    called to perform LLM/tool calls (Processing phase — NO writes)
 *  - onCompleted:  called when Processing succeeds (Writing phase — writes allowed)
 *  - onFailed:     called on non-conflict failure (Writing phase or terminal)
 *  - onConflicted: called when OCC returns 'demoted' (Writing phase, conflict path)
 */
export abstract class Worker {
  /**
   * Called in Initializing phase. May do lightweight setup.
   * MUST NOT call ctx.graph.write() — not yet in Writing phase.
   */
  abstract onScheduled(ctx: WorkerExecutionContext): Promise<void>;

  /**
   * Called in Processing phase. Performs LLM calls, tool invocations, computation.
   * MUST NOT call ctx.graph.write() — writing is forbidden during Processing.
   * Return accumulated in-memory results; lifecycle driver moves to Writing.
   */
  abstract onRunning(ctx: WorkerExecutionContext): Promise<void>;

  /**
   * Called in Writing phase after onRunning completes successfully.
   * ctx.graph.write() is permitted here. Flush all buffered results.
   */
  abstract onCompleted(ctx: WorkerExecutionContext): Promise<void>;

  /**
   * Called in Writing (or terminal) phase on non-conflict failure.
   * May write failure event or leave graph unchanged.
   */
  abstract onFailed(ctx: WorkerExecutionContext, error: Error): Promise<void>;

  /**
   * Called when OCC returns 'demoted' (second writer lost the race).
   * May write conflict_detected event or reconcile in-process.
   */
  abstract onConflicted(ctx: WorkerExecutionContext): Promise<void>;
}
