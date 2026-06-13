/**
 * Emergence read route (CONSOLE-REDESIGN §9 / Phase 21-console-redesign) — the
 * "what the system has learned" feed. Projects procedural_memory (crystallized
 * Lessons) as a human-readable list. The content is ALREADY LLM-distilled prose
 * (crystallize.worker: key insight + pattern + recommendation), so there is no
 * machine→human translation step — only presentation. Read-only SELECT.
 *
 *   GET /v1/emergence?limit=N  — lessons ordered by confidence, then recency
 *
 * Excludes anti-patterns (is_anti_pattern) and Ebbinghaus-superseded rows
 * (superseded_by IS NOT NULL) — the feed shows live, positive lessons. The
 * existing /v1/memory/search is semantic search, not a browsable feed.
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';

export function buildEmergenceRoute(pool: Pool): Hono {
  const app = new Hono();

  app.get('/emergence', async (c) => {
    const rawLimit = Number(c.req.query('limit') ?? 100);
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100;
    try {
      const res = await pool.query<{
        id: string;
        content: string | null;
        intent_description: string | null;
        confidence: number;
        reinforcement_count: number;
        last_used_at: string;
        created_at: string;
      }>(
        `SELECT id, content, intent_description, confidence,
                reinforcement_count, last_used_at::text AS last_used_at,
                created_at::text AS created_at
         FROM procedural_memory
         WHERE superseded_by IS NULL
           AND COALESCE(is_anti_pattern, FALSE) = FALSE
           AND content IS NOT NULL
         ORDER BY confidence DESC, last_used_at DESC
         LIMIT $1`,
        [limit],
      );
      return c.json({
        lessons: res.rows.map((r) => ({
          id: r.id,
          content: r.content,
          intent: r.intent_description,
          confidence: r.confidence,
          reinforcement_count: r.reinforcement_count,
          last_used_at: r.last_used_at,
          created_at: r.created_at,
        })),
      });
    } catch {
      // migration absent / empty system — no lessons yet (not an error)
      return c.json({ lessons: [] });
    }
  });

  return app;
}
