import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import type { EmbeddingProvider } from '@graph/shared';
import { buildMemoryRoute } from './memory.js';

const validScopeId = '123e4567-e89b-4d3c-a456-426614174000';

function makeEmbedding(): EmbeddingProvider {
  return {
    embed: vi.fn().mockResolvedValue({
      vector: new Array(1536).fill(0.1),
      countedAgainstBudget: false as const,
    }),
  };
}

describe('GET /memory/search', () => {
  let mockPool: Pool;
  let mockEmbedding: EmbeddingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbedding = makeEmbedding();
  });

  it('returns 200 with results array when pool returns rows with rrf_score', async () => {
    const rows = [
      { id: 'uuid-1', scope_id: validScopeId, content: 'fact A', rrf_score: 0.9 },
      { id: 'uuid-2', scope_id: validScopeId, content: 'fact B', rrf_score: 0.7 },
    ];
    mockPool = {
      query: vi.fn().mockResolvedValue({ rows, rowCount: 2 }),
    } as unknown as Pool;
    const app = buildMemoryRoute(mockPool, mockEmbedding);

    const res = await app.fetch(
      new Request(`http://localhost/memory/search?q=hello&scope_id=${validScopeId}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({ rrf_score: 0.9 });
  });

  it('returns 400 when scope_id is missing', async () => {
    mockPool = { query: vi.fn() } as unknown as Pool;
    const app = buildMemoryRoute(mockPool, mockEmbedding);

    const res = await app.fetch(new Request('http://localhost/memory/search?q=hello'));
    expect(res.status).toBe(400);
  });

  it('returns 400 when scope_id is not a valid UUID v4', async () => {
    mockPool = { query: vi.fn() } as unknown as Pool;
    const app = buildMemoryRoute(mockPool, mockEmbedding);

    const res = await app.fetch(
      new Request('http://localhost/memory/search?q=hello&scope_id=not-a-uuid'),
    );
    expect(res.status).toBe(400);
  });

  it('returns 500 when pool.query throws', async () => {
    mockPool = {
      query: vi.fn().mockRejectedValue(new Error('DB error')),
    } as unknown as Pool;
    const app = buildMemoryRoute(mockPool, mockEmbedding);

    const res = await app.fetch(
      new Request(`http://localhost/memory/search?q=hello&scope_id=${validScopeId}`),
    );
    expect(res.status).toBe(500);
  });
});

describe('POST /memory/reinforce', () => {
  let mockPool: Pool;
  let mockEmbedding: EmbeddingProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEmbedding = makeEmbedding();
  });

  it('returns 200 { reinforced: true } when pool.query resolves', async () => {
    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
    } as unknown as Pool;
    const app = buildMemoryRoute(mockPool, mockEmbedding);

    const res = await app.fetch(
      new Request('http://localhost/memory/reinforce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: 'template-uuid-123' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reinforced: boolean };
    expect(body.reinforced).toBe(true);
  });

  it('returns 400 when template_id is missing', async () => {
    mockPool = { query: vi.fn() } as unknown as Pool;
    const app = buildMemoryRoute(mockPool, mockEmbedding);

    const res = await app.fetch(
      new Request('http://localhost/memory/reinforce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 500 when pool.query throws', async () => {
    mockPool = {
      query: vi.fn().mockRejectedValue(new Error('DB error')),
    } as unknown as Pool;
    const app = buildMemoryRoute(mockPool, mockEmbedding);

    const res = await app.fetch(
      new Request('http://localhost/memory/reinforce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: 'template-uuid-123' }),
      }),
    );
    expect(res.status).toBe(500);
  });
});
