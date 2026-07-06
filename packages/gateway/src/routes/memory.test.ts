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

// ── Write-half of /memory (GH #34) ─────────────────────────────────────────────
describe('triage write-half', () => {
  const tplId = '223e4567-e89b-4d3c-a456-426614174999';
  beforeEach(() => vi.clearAllMocks());

  it('GET /memory/triage returns the ambiguous candidates with bands applied', async () => {
    const rows = [{ id: tplId, content: 'X before Y', success_count: 2, failure_count: 2, quality_score: 0.5, injection_count: 4 }];
    const query = vi.fn().mockResolvedValue({ rows, rowCount: 1 });
    const app = buildMemoryRoute({ query } as unknown as Pool, null);
    const res = await app.fetch(new Request('http://localhost/memory/triage'));
    expect(res.status).toBe(200);
    expect((await res.json() as { triage: unknown[] }).triage).toHaveLength(1);
    // bands threaded from FRESHNESS into the SQL params
    expect(query.mock.calls[0]![1]).toEqual([5, 0.3, 0.7]);
  });

  it('POST feedback success → success_count+1', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const app = buildMemoryRoute({ query } as unknown as Pool, null);
    const res = await app.fetch(new Request(`http://localhost/memory/templates/${tplId}/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'success' }),
    }));
    expect(res.status).toBe(200);
    expect(query.mock.calls[0]![0]).toContain('success_count = success_count + 1');
  });

  it('POST feedback rejects a non success/failure outcome (no numeric entry)', async () => {
    const app = buildMemoryRoute({ query: vi.fn() } as unknown as Pool, null);
    const res = await app.fetch(new Request(`http://localhost/memory/templates/${tplId}/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: '5' }),
    }));
    expect(res.status).toBe(400);
  });

  it('POST retire logically deletes (superseded_by=id)', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const app = buildMemoryRoute({ query } as unknown as Pool, null);
    const res = await app.fetch(new Request(`http://localhost/memory/templates/${tplId}/retire`, { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(query.mock.calls[0]![0]).toContain('superseded_by = id');
  });

  it('POST reinstate only un-supersedes a self-superseded row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const app = buildMemoryRoute({ query } as unknown as Pool, null);
    const res = await app.fetch(new Request(`http://localhost/memory/templates/${tplId}/reinstate`, { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(query.mock.calls[0]![0]).toContain('superseded_by = NULL');
    expect(query.mock.calls[0]![0]).toContain('superseded_by = id');
  });

  it('reinstate returns 404 when nothing was self-superseded', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const app = buildMemoryRoute({ query } as unknown as Pool, null);
    const res = await app.fetch(new Request(`http://localhost/memory/templates/${tplId}/reinstate`, { method: 'POST' }));
    expect(res.status).toBe(404);
  });
});
