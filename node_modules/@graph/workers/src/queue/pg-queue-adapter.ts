/**
 * PgQueueAdapter — PostgreSQL-backed IQueueAdapter implementation (Phase 1).
 *
 * Dequeues events atomically via FOR UPDATE SKIP LOCKED.
 * LISTEN/NOTIFY wakeup uses a dedicated pg.Client (NOT a Pool connection) —
 * using a Pool connection for LISTEN is an anti-pattern because pooled
 * connections are recycled and would drop the LISTEN registration.
 *
 * Backpressure: caller is responsible for not invoking nextEvent() when
 * activeWorkerCount >= MAX_PARALLELISM.  This class exposes an activeWorkerCount
 * field so the dispatch loop can track slot usage.
 *
 * Idempotency (REQ-18): all Worker writes use ON CONFLICT DO NOTHING.
 * Re-delivery is transparent — the queue adapter does not deduplicate.
 */

import { Client, Pool } from 'pg';
import type { EventLogNode } from '@graph/shared';
import { MAX_PARALLELISM } from '@shared/constants';
import type { IQueueAdapter } from './queue-adapter.interface.js';

/** SQL: atomically claim one pending_dispatch event (ADR 32 D-4). */
const DEQUEUE_SQL = `
  UPDATE execution_event_log
  SET status = 'processing', dispatched_at = NOW()
  WHERE id = (
    SELECT id
    FROM execution_event_log
    WHERE status = 'pending_dispatch' AND scope_id = $1
    ORDER BY event_id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING id, event_type, entity_id, scope_id, payload,
            predecessor_hash, version_hash, created_at
`;

export class PgQueueAdapter implements IQueueAdapter {
  /** Tracks in-flight Worker slots.  Caller increments/decrements this field. */
  public activeWorkerCount = 0;

  private readonly pool: Pool;
  private listenClient: Client | null = null;
  private wakeupCallbacks: Array<() => void> = [];

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Atomically claim the next pending_dispatch event for the scope.
   * Returns null when the queue is empty.
   *
   * Backpressure guard: returns null immediately when all Worker slots are
   * occupied (activeWorkerCount >= MAX_PARALLELISM) without touching the DB.
   */
  async nextEvent(scopeId: string): Promise<EventLogNode | null> {
    if (this.activeWorkerCount >= MAX_PARALLELISM) {
      return null;
    }

    // EventLogNode matches the pg QueryResultRow shape (plain object with string keys).
    // Cast via unknown to satisfy pg's generic bound without requiring EventLogNode
    // to explicitly extend QueryResultRow.
    const result = await this.pool.query(DEQUEUE_SQL, [scopeId]);
    return (result.rows[0] as EventLogNode) ?? null;
  }

  /**
   * Register a wakeup callback. Fires on every NOTIFY graph_event_ready
   * notification. Caller decides whether to call nextEvent() based on
   * activeWorkerCount.
   */
  onWakeup(cb: () => void): void {
    this.wakeupCallbacks.push(cb);
  }

  /**
   * Connect a dedicated pg.Client for LISTEN graph_event_ready.
   * Must be called once after construction to enable push-based wakeups.
   *
   * Uses a NON-POOLED Client — the LISTEN registration would be lost on
   * pool connection recycling (Anti-pattern documented in ADR 32 D-4).
   */
  async startListening(connectionString: string): Promise<void> {
    const client = new Client({ connectionString });
    await client.connect();
    await client.query('LISTEN graph_event_ready');

    client.on('notification', () => {
      // Wakeup signal only — no data in the payload per ADR 09.
      for (const cb of this.wakeupCallbacks) {
        cb();
      }
    });

    this.listenClient = client;
  }

  /** Tear down the dedicated LISTEN connection. */
  async stopListening(): Promise<void> {
    if (this.listenClient) {
      await this.listenClient.end();
      this.listenClient = null;
    }
  }
}
