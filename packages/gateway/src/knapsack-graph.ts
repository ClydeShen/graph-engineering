/**
 * KnapsackGraph factory for the Gateway write and read paths.
 *
 * A single factory covers both call sites via the `bypassView` option:
 *
 *   bypassView: false (default) — view-first strategy for the read path
 *     (GET /scopes/:id). Tries scope_lineage_view for O(1) index lookup on
 *     large scopes, falling back to the direct table scan when the view is
 *     stale or unavailable (ADR 05 supplement / migration 009).
 *
 *   bypassView: true — direct table scan for the write path (POST /events).
 *     The materialized view may not yet reflect the event just written, so the
 *     write path always bypasses it to guarantee freshness.
 *
 * @see ADR 13 (Knapsack Slicing)
 */

import type { Pool } from 'pg';
import type { KnapsackGraph } from '@shared/knapsack';
import type { EventLogNode } from '@shared/types';

const CHAIN_COLS = `id, scope_id, entity_id, event_type, predecessor_hash,
          version_hash, payload, status, base_priority, unlocks_count,
          spawned_by, last_active_at, created_at`;

/**
 * Build a KnapsackGraph for the given scope.
 *
 * @param pool       SELECT/INSERT pool.
 * @param scopeId    The scope to load.
 * @param opts.bypassView  Set true on the write path to skip the materialized
 *                         view and query execution_event_log directly.
 */
export async function makeKnapsackGraph(
  pool: Pool,
  scopeId: string,
  opts?: { bypassView?: boolean },
): Promise<KnapsackGraph> {
  let rows: EventLogNode[];

  if (opts?.bypassView) {
    // Write path: always read directly from the event log.
    // The materialized view may not yet reflect the event just written.
    const result = await pool.query<EventLogNode>(
      `SELECT ${CHAIN_COLS} FROM execution_event_log WHERE scope_id = $1 ORDER BY id ASC`,
      [scopeId],
    );
    rows = result.rows;
  } else {
    // Read path: try the materialized view first, fall back to the event log.
    try {
      const result = await pool.query<EventLogNode>(
        `SELECT ${CHAIN_COLS} FROM scope_lineage_view WHERE scope_id = $1 ORDER BY id ASC`,
        [scopeId],
      );
      rows = result.rows;
    } catch {
      const result = await pool.query<EventLogNode>(
        `SELECT ${CHAIN_COLS} FROM execution_event_log WHERE scope_id = $1 ORDER BY id ASC`,
        [scopeId],
      );
      rows = result.rows;
    }
  }

  const eventCache = new Map<string, EventLogNode>();
  for (const row of rows) {
    eventCache.set(row.version_hash, row);
  }
  const siblingRows = rows.filter(
    (r) => r.event_type === 'conflict_detected' ||
           r.status === 'pending_scheduling' ||
           r.status === 'pending_dispatch',
  );
  return {
    getEventByHash: (hash) => eventCache.get(hash),
    getSiblings: (_scopeId, excludeHash) =>
      siblingRows.filter((r) => r.version_hash !== excludeHash),
  };
}
