import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildHealthRoute } from './health.js';

function makePool(liveScopes: number, suspendedCount: number): Pool {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (/live_scopes/.test(sql)) {
        return Promise.resolve({ rows: [{ live_scopes: liveScopes, suspended_count: suspendedCount }] });
      }
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as Pool;
}

describe('GET /v1/sys/health', () => {
  it('returns 200 with correct shape', async () => {
    const pool = makePool(3, 1);
    const app = buildHealthRoute(pool);
    const res = await app.fetch(new Request('http://localhost/sys/health'));

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      engine_status: 'ok',
      live_scopes: 3,
      suspended_count: 1,
      slots: expect.any(Number),
      idle_slots: expect.any(Number),
    });
  });

  it('returns 503 degraded when DB query throws', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as Pool;
    const app = buildHealthRoute(pool);
    const res = await app.fetch(new Request('http://localhost/sys/health'));

    expect(res.status).toBe(503);
    const body = await res.json() as { engine_status: string };
    expect(body.engine_status).toBe('degraded');
  });

  it('live_scopes and suspended_count reflect DB counts', async () => {
    const pool = makePool(7, 2);
    const app = buildHealthRoute(pool);
    const res = await app.fetch(new Request('http://localhost/sys/health'));

    const body = await res.json() as { live_scopes: number; suspended_count: number };
    expect(body.live_scopes).toBe(7);
    expect(body.suspended_count).toBe(2);
  });
});
