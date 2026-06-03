import { Hono } from 'hono';
import type { Pool } from 'pg';
import { validateScopeIdParam } from '../middleware/zod-guard.js';

const ZERO_HASH = '0'.repeat(64);

type EventRow = {
  version_hash: string;
  predecessor_hash: string;
  entity_id: string;
  event_type: string;
};

export function buildTopologyRoute(pool: Pool): Hono {
  const app = new Hono();

  app.get('/scopes/:id/topology', async (c) => {
    const id = c.req.param('id');
    const invalid = validateScopeIdParam(c, id);
    if (invalid) return invalid;

    const lineage = await pool.query(
      `SELECT scope_id FROM scope_lineage WHERE scope_id = $1 LIMIT 1`,
      [id],
    );
    if (lineage.rows.length === 0) {
      return c.json({ error: 'scope not found' }, 404);
    }

    const MAX_NODES = 500;
    const result = await pool.query<EventRow>(
      `SELECT version_hash, predecessor_hash, entity_id, event_type
       FROM execution_event_log
       WHERE scope_id = $1
       ORDER BY id ASC
       LIMIT $2`,
      [id, MAX_NODES + 1],
    );

    const truncated = result.rows.length > MAX_NODES;
    const rows = truncated ? result.rows.slice(0, MAX_NODES) : result.rows;

    const nodes = rows.map((r) => ({
      id: r.version_hash,
      entity_id: r.entity_id,
      event_type: r.event_type,
    }));

    const edges = rows
      .filter((r) => r.predecessor_hash !== ZERO_HASH)
      .map((r) => ({ source: r.predecessor_hash, target: r.version_hash }));

    return c.json({ nodes, edges, truncated });
  });

  return app;
}
