import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildTopologyRoute } from './topology.js';

const ZERO_HASH = '0'.repeat(64);
const VALID_UUID = '123e4567-e89b-4d3a-a456-426614174000';

type EventRow = { version_hash: string; predecessor_hash: string; entity_id: string; event_type: string };

function makePool(rows: EventRow[], scopeExists = true): Pool {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (/scope_lineage/.test(sql)) {
        return Promise.resolve({ rows: scopeExists ? [{ scope_id: VALID_UUID }] : [] });
      }
      return Promise.resolve({ rows });
    }),
  } as unknown as Pool;
}

describe('GET /v1/scopes/:id/topology', () => {
  it('returns 200 with nodes and edges for a known scope', async () => {
    const pool = makePool([
      { version_hash: 'aaa', predecessor_hash: ZERO_HASH, entity_id: 'e1', event_type: 'plan_created' },
    ]);
    const app = buildTopologyRoute(pool);
    const res = await app.fetch(new Request(`http://localhost/scopes/${VALID_UUID}/topology`));

    expect(res.status).toBe(200);
    const body = await res.json() as { nodes: unknown[]; edges: unknown[] };
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
  });

  it('nodes contain version_hash, entity_id, and event_type', async () => {
    const pool = makePool([
      { version_hash: 'aaa', predecessor_hash: ZERO_HASH, entity_id: 'e1', event_type: 'plan_created' },
    ]);
    const app = buildTopologyRoute(pool);
    const res = await app.fetch(new Request(`http://localhost/scopes/${VALID_UUID}/topology`));

    const { nodes } = await res.json() as { nodes: Array<{ id: string; entity_id: string; event_type: string }> };
    expect(nodes[0]).toMatchObject({ id: 'aaa', entity_id: 'e1', event_type: 'plan_created' });
  });

  it('edges link predecessor_hash to version_hash, excluding ZERO_HASH source', async () => {
    const pool = makePool([
      { version_hash: 'aaa', predecessor_hash: ZERO_HASH, entity_id: 'e1', event_type: 'plan_created' },
      { version_hash: 'bbb', predecessor_hash: 'aaa',     entity_id: 'e2', event_type: 'task_spawned' },
    ]);
    const app = buildTopologyRoute(pool);
    const res = await app.fetch(new Request(`http://localhost/scopes/${VALID_UUID}/topology`));

    const { edges } = await res.json() as { edges: Array<{ source: string; target: string }> };
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ source: 'aaa', target: 'bbb' });
  });

  it('returns 404 for unknown scope', async () => {
    const pool = makePool([], false);
    const app = buildTopologyRoute(pool);
    const res = await app.fetch(new Request(`http://localhost/scopes/${VALID_UUID}/topology`));

    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid UUID', async () => {
    const pool = makePool([]);
    const app = buildTopologyRoute(pool);
    const res = await app.fetch(new Request('http://localhost/scopes/not-a-uuid/topology'));

    expect(res.status).toBe(400);
  });
});
