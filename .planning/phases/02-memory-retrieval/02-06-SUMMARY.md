---
plan: 02-06
status: complete
wave: 3
---

## Hybrid BM25+HNSW RRF Retrieval — GET /v1/memory/search + POST /v1/memory/reinforce

### Artifacts created

| File | Description |
|---|---|
| `packages/gateway/src/routes/memory.ts` | `buildMemoryRoute(pool, embedding)` — hybrid RRF search + reinforce |
| `packages/gateway/src/routes/memory.test.ts` | 7 unit tests — all pass |
| `packages/gateway/src/index.ts` | Mounts memory route; adds `gatewayLlmProvider` (module-level) |

### buildMemoryRoute behavior

- `buildMemoryRoute(pool: Pool, embedding: EmbeddingProvider): Hono`
- **GET /memory/search** (mounted at `/v1/memory/search` via gateway index):
  1. Validates `scope_id` query param — 400 if missing or not UUID v4
  2. Calls `embedding.embed(q)` to get vector; formats as pgvector literal `[v1,v2,...]`
  3. Runs hybrid BM25+HNSW RRF SQL against `semantic_memory` (scope_id=$4 in BOTH CTEs)
  4. RRF weights: vector=0.6, BM25=0.4, K=60; returns top 10 rows
  5. Returns `{ results: rows }` — 500 on DB/embed error
- **POST /memory/reinforce**:
  1. Parses JSON body; 400 if `template_id` missing
  2. `UPDATE procedural_memory SET reinforcement_count = reinforcement_count + 1, last_used_at = NOW() WHERE id = $1`
  3. Returns `{ reinforced: true }` — 500 on DB error

### RRF SQL structure

```sql
vector_candidates: ORDER BY embedding <=> $1 LIMIT 20, WHERE scope_id = $4
bm25_candidates:   plainto_tsquery('english', $2), WHERE ts_doc @@ query AND scope_id = $4
rrf_scored: 0.6*(1/(60+vector_rank)) + 0.4*(1/(60+bm25_rank))
```
Parameters: $1=embeddingLiteral, $2=queryText, $3=10(k), $4=scopeId

### UUID v4 validation

Inline regex: `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`

### Tests

1. GET returns 200 with `results` array containing rows from pool
2. GET returns 400 when `scope_id` is missing
3. GET returns 400 when `scope_id` is not a valid UUID v4
4. GET returns 500 when `pool.query` throws
5. POST returns 200 `{ reinforced: true }` when pool resolves
6. POST returns 400 when `template_id` is missing
7. POST returns 500 when `pool.query` throws
