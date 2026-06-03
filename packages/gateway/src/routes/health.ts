import { Hono } from 'hono';
import type { Pool } from 'pg';

export function buildHealthRoute(pool: Pool): Hono {
  const app = new Hono();

  app.get('/sys/health', async (c) => {
    try {
      const result = await pool.query<{ live_scopes: number; suspended_count: number }>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'active')    AS live_scopes,
           COUNT(*) FILTER (WHERE status = 'suspended') AS suspended_count
         FROM scope_lineage`,
      );

      const { live_scopes, suspended_count } = result.rows[0] ?? { live_scopes: 0, suspended_count: 0 };
      const p = pool as { totalCount?: number; idleCount?: number };

      return c.json({
        engine_status: 'ok',
        live_scopes: Number(live_scopes),
        suspended_count: Number(suspended_count),
        slots: p.totalCount ?? 0,
        idle_slots: p.idleCount ?? 0,
      });
    } catch {
      return c.json({ engine_status: 'degraded' }, 503);
    }
  });

  return app;
}
