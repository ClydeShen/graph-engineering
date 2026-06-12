/**
 * scope-read.test.ts — GET /v1/scopes list endpoint (UX-audit U17).
 *
 * The list feeds console scope pickers: newest first, limit clamped to
 * [1, 200], read-only. The :id route is covered by integration paths.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildScopeReadRoute } from './scope-read.js';

const SAMPLE = [
  { scope_id: '123e4567-e89b-4d3a-a456-426614174000', intent: 'session:terminal:1', status: 'active', created_at: '2026-06-13T00:00:00Z' },
];

function makePool(): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rows: SAMPLE });
  return { pool: { query } as unknown as Pool, query };
}

describe('GET /v1/scopes (list)', () => {
  it('returns recent scopes with intent/status/created_at', async () => {
    const { pool } = makePool();
    const app = buildScopeReadRoute(pool, 4096);
    const res = await app.fetch(new Request('http://localhost/'));

    expect(res.status).toBe(200);
    const body = await res.json() as { scopes: typeof SAMPLE };
    expect(body.scopes).toHaveLength(1);
    expect(body.scopes[0]).toMatchObject({ scope_id: SAMPLE[0].scope_id, intent: 'session:terminal:1', status: 'active' });
  });

  it('clamps limit to [1, 200] and defaults to 50', async () => {
    const { pool, query } = makePool();
    const app = buildScopeReadRoute(pool, 4096);

    await app.fetch(new Request('http://localhost/?limit=999'));
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [200]);

    await app.fetch(new Request('http://localhost/?limit=0'));
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [1]);

    await app.fetch(new Request('http://localhost/?limit=abc'));
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [50]);

    await app.fetch(new Request('http://localhost/'));
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [50]);
  });
});
