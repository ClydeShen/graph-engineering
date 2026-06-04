import { Hono } from 'hono';
import type { Pool } from 'pg';
import type { EmbeddingProvider } from '@graph/shared';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const HYBRID_RRF_SQL = `
WITH
vector_candidates AS (
  SELECT id, content, scope_id,
         ROW_NUMBER() OVER (ORDER BY embedding <=> $1) AS vector_rank
  FROM semantic_memory
  WHERE embedding IS NOT NULL AND scope_id = $4
  ORDER BY embedding <=> $1
  LIMIT 20
),
bm25_candidates AS (
  SELECT id,
         ts_rank_cd(ts_doc, query) AS bm25_raw_score,
         ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ts_doc, query) DESC) AS bm25_rank
  FROM semantic_memory,
       plainto_tsquery('english', $2) AS query
  WHERE ts_doc @@ query AND scope_id = $4
  ORDER BY bm25_raw_score DESC
  LIMIT 20
),
all_candidates AS (SELECT id FROM vector_candidates UNION SELECT id FROM bm25_candidates),
rrf_scored AS (
  SELECT ac.id,
    0.6 * (1.0 / (60 + COALESCE(vc.vector_rank, 21))) +
    0.4 * (1.0 / (60 + COALESCE(bc.bm25_rank,   21))) AS rrf_score
  FROM all_candidates ac
  LEFT JOIN vector_candidates vc ON ac.id = vc.id
  LEFT JOIN bm25_candidates   bc ON ac.id = bc.id
)
SELECT s.id, s.scope_id, s.content, r.rrf_score
FROM rrf_scored r JOIN semantic_memory s ON r.id = s.id
ORDER BY r.rrf_score DESC LIMIT $3
`;

export function buildMemoryRoute(pool: Pool, embedding: EmbeddingProvider): Hono {
  const app = new Hono();

  app.get('/memory/search', async (c) => {
    const q = c.req.query('q') ?? '';
    const scopeId = c.req.query('scope_id');

    if (!scopeId) return c.json({ error: 'scope_id is required' }, 400);
    if (!UUID_V4_RE.test(scopeId)) return c.json({ error: 'scope_id must be a valid UUID v4' }, 400);

    try {
      const embedResult = await embedding.embed(q);
      const embeddingLiteral = `[${embedResult.vector.join(',')}]`;
      const { rows } = await pool.query(HYBRID_RRF_SQL, [embeddingLiteral, q, 10, scopeId]);
      return c.json({ results: rows });
    } catch {
      return c.json({ error: 'internal server error' }, 500);
    }
  });

  app.post('/memory/reinforce', async (c) => {
    const body = await c.req.json<{ template_id?: string }>().catch(() => ({} as { template_id?: string }));
    if (!body.template_id) return c.json({ error: 'template_id is required' }, 400);

    try {
      await pool.query(
        `UPDATE procedural_memory SET reinforcement_count = reinforcement_count + 1, last_used_at = NOW() WHERE id = $1`,
        [body.template_id],
      );
      return c.json({ reinforced: true });
    } catch {
      return c.json({ error: 'internal server error' }, 500);
    }
  });

  return app;
}
