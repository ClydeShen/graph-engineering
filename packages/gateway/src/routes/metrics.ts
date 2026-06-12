/**
 * Console metrics + suspended-audit routes (UI-SPEC Pages 2/3 contracts,
 * landed with Phase 19 — the spec defined them in Phase 3, the consumer
 * arrives now).
 *
 *   GET /v1/metrics/infra            — point-in-time infra gauge (poll 2s)
 *   GET /v1/scopes/audit/suspended   — suspended scope cards (poll 5s)
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';

export interface InfraMetrics {
  timestamp: number;
  active_slots: number;
  max_slots: number;
  queue_backlog: number;
}

export function buildMetricsRoute(pool: Pool): Hono {
  const app = new Hono();

  app.get('/metrics/infra', async (c) => {
    try {
      const backlog = await pool.query<{ backlog: string }>(
        `SELECT COUNT(*)::text AS backlog FROM execution_event_log
         WHERE status IN ('pending_scheduling', 'pending_dispatch')`,
      );
      const p = pool as { totalCount?: number; idleCount?: number; options?: { max?: number } };
      const max = p.options?.max ?? 10;
      const total = p.totalCount ?? 0;
      const idle = p.idleCount ?? 0;
      return c.json<InfraMetrics>({
        timestamp: Math.floor(Date.now() / 1000),
        active_slots: Math.max(0, total - idle),
        max_slots: max,
        queue_backlog: Number(backlog.rows[0]?.backlog ?? 0),
      });
    } catch {
      return c.json({ error: 'metrics unavailable' }, 503);
    }
  });

  app.get('/scopes/audit/suspended', async (c) => {
    try {
      const res = await pool.query<{
        scope_id: string;
        status: string;
        intent: string;
        frozen_at: string | null;
        unconverged: string;
      }>(
        `SELECT sl.scope_id, sl.status, sl.intent,
                MAX(e.created_at)::text AS frozen_at,
                COUNT(*) FILTER (WHERE e.status NOT IN ('archived', 'converged'))::text AS unconverged
         FROM scope_lineage sl
         LEFT JOIN execution_event_log e ON e.scope_id = sl.scope_id
         WHERE sl.status = 'suspended'
         GROUP BY sl.scope_id, sl.status, sl.intent
         ORDER BY MAX(e.created_at) DESC NULLS LAST
         LIMIT 100`,
      );
      return c.json(
        res.rows.map((r) => ({
          scope_id: r.scope_id,
          status: r.status,
          error_reason: r.intent, // intent carries the suspension context in v1
          frozen_at: r.frozen_at,
          unconverged_nodes_count: Number(r.unconverged),
        })),
      );
    } catch {
      return c.json({ error: 'audit unavailable' }, 503);
    }
  });

  return app;
}
