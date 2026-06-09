/**
 * KnapsackGraph factory functions for the Gateway write and read paths.
 *
 * Two strategies mirror the two call sites:
 *   makeKnapsackGraph         — write path (events.ts): direct table scan, no view
 *   makeKnapsackGraphFromView — read path (scope-read.ts): view-first with fallback
 *
 * The view-first strategy uses scope_lineage_view (materialized cache) for O(1)
 * index lookup on large scopes (>50 tasks), falling back to the direct table scan
 * when the view is stale or unavailable (ADR 05 supplement / migration 009).
 *
 * @see ADR 13 (Knapsack Slicing)
 */

import type { Pool } from 'pg';
import type { KnapsackGraph } from '@graph/workers/context/knapsack';
import type { EventLogNode } from '@shared/types';

const CHAIN_COLS = `id, scope_id, entity_id, event_type, predecessor_hash,
          version_hash, payload, status, base_priority, unlocks_count,
          spawned_by, last_active_at, created_at`;

/**
 * Build a KnapsackGraph by querying execution_event_log directly.
 * Used in the write path (POST /events) where scope_lineage_view may not
 * yet reflect the event just written.
 */
export async function makeKnapsackGraph(
  pool: Pool,
  scopeId: string,
): Promise<KnapsackGraph> {
  const result = await pool.query<EventLogNode>(
    `SELECT ${CHAIN_COLS} FROM execution_event_log WHERE scope_id = $1 ORDER BY id ASC`,
    [scopeId],
  );
  const eventCache = new Map<string, EventLogNode>();
  for (const row of result.rows) {
    eventCache.set(row.version_hash, row);
  }
  return {
    getEventByHash: (hash) => eventCache.get(hash),
    getSiblings: () => [],
  };
}

/**
 * Build a KnapsackGraph using scope_lineage_view first, falling back to
 * execution_event_log when the view is unavailable or stale.
 * Used in the read path (GET /scopes/:id).
 */
export async function makeKnapsackGraphFromView(
  pool: Pool,
  scopeId: string,
): Promise<KnapsackGraph> {
  let rows: EventLogNode[];
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
  const eventCache = new Map<string, EventLogNode>();
  for (const row of rows) {
    eventCache.set(row.version_hash, row);
  }
  return {
    getEventByHash: (hash) => eventCache.get(hash),
    getSiblings: () => [],
  };
}
