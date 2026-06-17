import { Hono } from 'hono';
import type { Pool } from 'pg';
import type { EmbeddingProvider } from '@graph/shared';
import { PoolMemoryRepository } from '@graph/workers/base/memory-repository';
import { FRESHNESS } from '@graph/workers/memory/freshness-config';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BM25_ONLY_SQL = `
SELECT id, scope_id, content,
       ts_rank_cd(ts_doc, plainto_tsquery('english', $1)) AS rrf_score
FROM semantic_memory
WHERE ts_doc @@ plainto_tsquery('english', $1) AND scope_id = $3
ORDER BY rrf_score DESC
LIMIT $2
`;

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

/**
 * Search semantic memory using hybrid Reciprocal Rank Fusion (vector + BM25) when an
 * embedding is available, falling back to BM25-only when the embedding provider fails or
 * returns an empty vector. RRF weights: 0.6 vector / 0.4 BM25.
 *
 * Exported for independent testing and future reuse (e.g. Trail Discovery).
 */
export async function searchSemanticMemory(
  pool: Pool,
  embedding: EmbeddingProvider | null,
  query: string,
  scopeId: string,
  limit: number,
): Promise<unknown[]> {
  try {
    if (embedding === null) throw new Error('no embedding provider (degraded mode, ADR 55)');
    const embedResult = await embedding.embed(query);
    if (embedResult.vector.length === 0) throw new Error('empty vector');
    const embeddingLiteral = `[${embedResult.vector.join(',')}]`;
    const { rows } = await pool.query(HYBRID_RRF_SQL, [embeddingLiteral, query, limit, scopeId]);
    return rows;
  } catch {
    // Embedding unavailable or empty — fall back to BM25-only search
    const { rows } = await pool.query(BM25_ONLY_SQL, [query, limit, scopeId]);
    return rows;
  }
}

export function buildMemoryRoute(pool: Pool, embedding: EmbeddingProvider | null): Hono {
  const app = new Hono();

  app.get('/memory/search', async (c) => {
    const q = c.req.query('q') ?? '';
    const scopeId = c.req.query('scope_id');

    if (!scopeId) return c.json({ error: 'scope_id is required' }, 400);
    if (!UUID_V4_RE.test(scopeId)) return c.json({ error: 'scope_id must be a valid UUID v4' }, 400);

    try {
      const results = await searchSemanticMemory(pool, embedding, q, scopeId, 10);
      return c.json({ results });
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

  // ── Write-half of /memory (GH #34) — the human triage/edit surface ──────────
  // The grey zone of metabolism (#32) is the human teaching surface: ambiguous
  // crystallizations are NEVER silently decided, they surface here with their
  // success-rate. The human corrects drift via natural actions (keep / retire /
  // approve-step / reinstate), never a typed number; the action flows back as
  // clean, human-localized attribution. No-action degrades to the automatic
  // signal (the cron handles the proven cases on its own).
  const memory = new PoolMemoryRepository(pool);

  app.get('/memory/triage', async (c) => {
    try {
      const rows = await memory.getMetabolismTriage({
        nMin: FRESHNESS.metabolismNMin,
        qualityBad: FRESHNESS.metabolismQualityBad,
        qualityGood: FRESHNESS.metabolismQualityGood,
      });
      return c.json({ triage: rows });
    } catch {
      return c.json({ error: 'internal server error' }, 500);
    }
  });

  /**
   * Verification-checkpoint writeback (#33/#34): the human approves or corrects a
   * recalled procedure on a key step. 'success' credits the ingredient, 'failure'
   * softens it — natural accept/deny, no numeric entry.
   */
  app.post('/memory/templates/:id/feedback', async (c) => {
    const id = c.req.param('id');
    if (!UUID_V4_RE.test(id)) return c.json({ error: 'id must be a valid UUID v4' }, 400);
    const body = await c.req.json<{ outcome?: string }>().catch(() => ({}) as { outcome?: string });
    if (body.outcome !== 'success' && body.outcome !== 'failure') {
      return c.json({ error: "outcome must be 'success' or 'failure'" }, 400);
    }
    const column = body.outcome === 'success' ? 'success_count' : 'failure_count';
    try {
      const { rowCount } = await pool.query(
        `UPDATE procedural_memory SET ${column} = ${column} + 1, last_used_at = NOW()
         WHERE id = $1 AND is_anti_pattern = FALSE`,
        [id],
      );
      return (rowCount ?? 0) > 0 ? c.json({ ok: true, outcome: body.outcome }) : c.json({ error: 'not found' }, 404);
    } catch {
      return c.json({ error: 'internal server error' }, 500);
    }
  });

  /** Human retires an ambiguous crystallization (reversible logical-delete). */
  app.post('/memory/templates/:id/retire', async (c) => {
    const id = c.req.param('id');
    if (!UUID_V4_RE.test(id)) return c.json({ error: 'id must be a valid UUID v4' }, 400);
    try {
      const { rowCount } = await pool.query(
        `UPDATE procedural_memory SET superseded_by = id
         WHERE id = $1 AND is_anti_pattern = FALSE AND superseded_by IS NULL`,
        [id],
      );
      return (rowCount ?? 0) > 0 ? c.json({ retired: true }) : c.json({ error: 'not found or already retired' }, 404);
    } catch {
      return c.json({ error: 'internal server error' }, 500);
    }
  });

  /** Human override (highest authority): reinstate a metabolized/atrophied template. */
  app.post('/memory/templates/:id/reinstate', async (c) => {
    const id = c.req.param('id');
    if (!UUID_V4_RE.test(id)) return c.json({ error: 'id must be a valid UUID v4' }, 400);
    try {
      const reinstated = await memory.reinstateTemplate(id);
      return reinstated ? c.json({ reinstated: true }) : c.json({ error: 'not found or not self-superseded' }, 404);
    } catch {
      return c.json({ error: 'internal server error' }, 500);
    }
  });

  return app;
}
