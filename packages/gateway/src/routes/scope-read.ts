/**
 * GET /v1/scopes/:id — read scope state and current context.
 *
 * Validates the UUID before any DB access (ADR 24 Zod gate).
 * Reads scope status from scope_lineage + latest event version_hash from
 * execution_event_log, then assembles the Knapsack context for the response.
 *
 * No DDL is issued — this is a read-only path using the SELECT pool.
 *
 * @see ADR 24 — HTTP Gateway spec; GET /v1/scopes/:id
 * @see ADR 13 — Knapsack Slicing (read-only projection)
 * @see REQ-15 — GET /v1/scopes/:id endpoint
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { validateScopeIdParam } from '../middleware/zod-guard.js';
import { assembleContext } from '@graph/workers/context/assemble';
import { makeKnapsackGraphFromView } from '../knapsack-graph.js';

/**
 * Build the scope-read route.
 *
 * @param pool  SELECT/INSERT pool (SELECT-only queries here)
 * @param wMax  Context assembly token budget (read from env at boot, ADR 22)
 */
export function buildScopeReadRoute(pool: Pool, wMax: number): Hono {
  const app = new Hono();

  /**
   * GET /v1/scopes/:id
   * Response: { scope_id, status, context }
   *
   * status is 'active' | 'closed' | 'suspended'
   * context is AssembledContext (or null if scope is closed)
   */
  app.get('/:id', async (c) => {
    const id = c.req.param('id');

    // Zod gate — UUID validation BEFORE any DB access (ADR 24)
    const invalid = validateScopeIdParam(c, id);
    if (invalid) return invalid;

    // Read scope status from scope_lineage
    const lineageResult = await pool.query<{
      scope_id: string;
      status: string;
    }>(
      `SELECT scope_id, status FROM scope_lineage WHERE scope_id = $1 LIMIT 1`,
      [id],
    );

    if (lineageResult.rows.length === 0) {
      return c.json({ error: 'scope not found' }, 404);
    }

    const { status } = lineageResult.rows[0];
    const scopeClosed = status === 'closed';

    // Read the most recent event to get the current rootHash for context assembly
    const latestResult = await pool.query<{ version_hash: string }>(
      `SELECT version_hash
       FROM execution_event_log
       WHERE scope_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [id],
    );

    const rootHash = latestResult.rows[0]?.version_hash ?? '';

    // makeKnapsackGraphFromView: O(1) via scope_lineage_view for large scopes,
    // falls back to direct table scan (ADR 05 supplement / migration 009).
    const graph = await makeKnapsackGraphFromView(pool, id);

    const context = await assembleContext(
      graph,
      id,
      rootHash,
      {},
      wMax,
      scopeClosed,
    );

    return c.json({ scope_id: id, status, context });
  });

  return app;
}
