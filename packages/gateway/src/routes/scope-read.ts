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
import { makeKnapsackGraph } from '../knapsack-graph.js';

/**
 * Build the scope-read route.
 *
 * @param pool  SELECT/INSERT pool (SELECT-only queries here)
 * @param wMax  Context assembly token budget (read from env at boot, ADR 22)
 */
export function buildScopeReadRoute(pool: Pool, wMax: number): Hono {
  const app = new Hono();

  /**
   * GET /v1/scopes — recent scopes for pickers (UX-audit U17).
   * Response: { scopes: [{ scope_id, intent, status, created_at }] }
   * ?limit=N (default 50, max 200). Read-only, newest first.
   */
  app.get('/', async (c) => {
    const rawLimit = Number(c.req.query('limit') ?? 50);
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    const result = await pool.query<{
      scope_id: string;
      intent: string | null;
      status: string;
      created_at: string;
    }>(
      `SELECT scope_id, intent, status, created_at
       FROM scope_lineage
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit],
    );
    return c.json({ scopes: result.rows });
  });

  /**
   * GET /v1/scopes/:id/messages — conversation projection (ADR 54).
   * Replays the scope's conversation.user / conversation.assistant events
   * (memory_updated payloads) in trail order so chat clients can resume a
   * session. Erased events (ADR-47) are excluded.
   * Response: { scope_id, messages: [{ role, text, at }] }
   */
  app.get('/:id/messages', async (c) => {
    const id = c.req.param('id');
    const invalid = validateScopeIdParam(c, id);
    if (invalid) return invalid;

    const result = await pool.query<{ payload: string; created_at: string }>(
      `SELECT payload, created_at
       FROM execution_event_log
       WHERE scope_id = $1 AND event_type = 'memory_updated' AND erased_at IS NULL
       ORDER BY id ASC`,
      [id],
    );

    const messages: Array<{ role: 'user' | 'assistant'; text: string; at: string }> = [];
    for (const row of result.rows) {
      try {
        const p = JSON.parse(row.payload) as { kind?: string; text?: string };
        if (typeof p.text !== 'string') continue;
        if (p.kind === 'conversation.user') {
          messages.push({ role: 'user', text: p.text, at: row.created_at });
        } else if (p.kind === 'conversation.assistant') {
          messages.push({ role: 'assistant', text: p.text, at: row.created_at });
        }
      } catch {
        /* non-JSON payload — not a conversation event */
      }
    }

    return c.json({ scope_id: id, messages });
  });

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

    // Read path: view-first with fallback (ADR 05 supplement / migration 009).
    const graph = await makeKnapsackGraph(pool, id);

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
