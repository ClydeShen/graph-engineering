/**
 * ContextAssemblyWorker — assembles the 3-layer prompt projection for each Agent call.
 *
 * Processing phase: calls assembleContext() from the causal graph lineage (read-only).
 * Writing phase: writes the assembled context snapshot to the graph via GraphHandle.
 *
 * The KnapsackGraph interface requires SYNC getEventByHash/getSiblings, so the
 * in-memory adapter is built from DB rows loaded in onScheduled().
 *
 * @see ADR 30 — Context Assembly Strategy
 * @see ADR 27 — Worker lifecycle (ZERO writes during Processing)
 */

import type { EventLogNode } from '@shared/types';
import { assembleContext, type AssembledContext } from '../context/assemble.js';
import type { KnapsackGraph } from '../context/knapsack.js';
import { Worker, type WorkerExecutionContext } from '../base/worker.abstract.js';

const W_MAX_DEFAULT = 8000;

/** In-memory KnapsackGraph built from DB rows — satisfies the sync interface. */
class InMemoryKnapsackGraph implements KnapsackGraph {
  private readonly byHash = new Map<string, EventLogNode>();
  private readonly byScope = new Map<string, EventLogNode[]>();

  load(events: EventLogNode[]): void {
    for (const e of events) {
      this.byHash.set(e.version_hash, e);
      const list = this.byScope.get(e.scope_id) ?? [];
      list.push(e);
      this.byScope.set(e.scope_id, list);
    }
  }

  getEventByHash(hash: string): EventLogNode | undefined {
    return this.byHash.get(hash);
  }

  getSiblings(scopeId: string, excludeHash: string): EventLogNode[] {
    return (this.byScope.get(scopeId) ?? []).filter(
      (e) => e.version_hash !== excludeHash && (e.event_type === 'task_spawned' || e.event_type === 'conflict_detected'),
    );
  }
}

export class ContextAssemblyWorker extends Worker {
  private graph!: InMemoryKnapsackGraph;
  private assembled: AssembledContext | null = null;

  async onScheduled(ctx: WorkerExecutionContext): Promise<void> {
    // Load all events for the scope into an in-memory adapter so
    // knapsackSlice can traverse the causal chain synchronously.
    const rows = await ctx.graph.query<EventLogNode>(
      `SELECT version_hash, scope_id, entity_id, event_type, predecessor_hash, payload, created_at
         FROM execution_event_log WHERE scope_id = $1 ORDER BY created_at ASC`,
      [ctx.scopeId],
    );
    this.graph = new InMemoryKnapsackGraph();
    this.graph.load(rows);
  }

  async onRunning(ctx: WorkerExecutionContext): Promise<void> {
    // Processing phase — NO writes. Assemble context into memory only.
    const input = ctx.input as { rootHash?: string; wMax?: number; scopeClosed?: boolean } | undefined;
    this.assembled = await assembleContext(
      this.graph,
      ctx.scopeId,
      input?.rootHash ?? ctx.currentVersionHash,
      ctx.input,
      input?.wMax ?? W_MAX_DEFAULT,
      input?.scopeClosed ?? false,
    );
  }

  async onCompleted(ctx: WorkerExecutionContext): Promise<void> {
    if (!this.assembled) return;
    // Writing phase — flush assembled context projection as a memory_updated event.
    await ctx.graph.write({
      scope_id: ctx.scopeId,
      entity_id: ctx.entityId,
      event_type: 'memory_updated',
      predecessor_hash: ctx.currentVersionHash,
      canonical_json_text: JSON.stringify({
        worker: 'graph::context-assembly',
        stable_tokens: this.assembled.stable.length,
        context_events: this.assembled.context?.length ?? 0,
        scope_closed: this.assembled.context === null,
      }),
    });
  }

  async onFailed(_ctx: WorkerExecutionContext, _error: Error): Promise<void> {
    // No writes on failure — graph remains unchanged; caller can re-queue.
  }

  async onConflicted(_ctx: WorkerExecutionContext): Promise<void> {
    // OCC demoted — context assembly is idempotent; no action needed.
  }
}
