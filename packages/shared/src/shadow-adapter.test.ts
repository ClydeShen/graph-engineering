import { describe, it, expect, vi } from 'vitest';
import { InMemoryShadowAdapter } from './write-guard.js';

const OCC_SQL = `WITH new_version AS (
  INSERT INTO execution_event_log_202506
  (scope_id, entity_id, predecessor_hash, payload, event_type)
  VALUES ($1::uuid, $2::uuid, $3, $4::text, $5)
  ON CONFLICT (predecessor_hash, scope_id) DO UPDATE SET updated_at = NOW()
)
SELECT version_hash, event_type, occ_result FROM new_version`;

const DO_NOTHING_SQL = `WITH new_version AS (
  INSERT INTO execution_event_log_202506
  (scope_id, entity_id, predecessor_hash, payload, event_type)
  VALUES ($1::uuid, $2::uuid, $3, $4::text, 'memory_updated')
  ON CONFLICT DO NOTHING
)
SELECT version_hash, event_type, occ_result FROM new_version`;

function makeRealPool() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [{ id: 1, entity_id: 'e-real' }], rowCount: 1 };
    },
    calls,
  };
  return pool;
}

describe('InMemoryShadowAdapter', () => {
  it('OCC write is captured; real pool is NOT called; occ_result=won', async () => {
    const real = makeRealPool();
    const shadow = new InMemoryShadowAdapter(real);
    const result = await shadow.proxy.query(OCC_SQL, [
      'scope-1', 'entity-1', 'ZERO_HASH', '{"task":"refactor"}', 'task_spawned',
    ]);

    expect(real.calls).toHaveLength(0);
    expect(shadow.getEntries()).toHaveLength(1);
    expect(shadow.getEntries()[0].scopeId).toBe('scope-1');
    expect((result.rows[0] as { occ_result: string }).occ_result).toBe('won');
  });

  it('SELECT passes through to real pool; entries unchanged', async () => {
    const real = makeRealPool();
    const shadow = new InMemoryShadowAdapter(real);
    const result = await shadow.proxy.query(
      'SELECT * FROM execution_event_log WHERE scope_id = $1',
      ['scope-1'],
    );

    expect(real.calls).toHaveLength(1);
    expect(shadow.getEntries()).toHaveLength(0);
    expect((result.rows[0] as { entity_id: string }).entity_id).toBe('e-real');
  });

  it('multiple OCC writes accumulate in entries; only 1 real pool call (the SELECT)', async () => {
    const real = makeRealPool();
    const shadow = new InMemoryShadowAdapter(real);

    await shadow.proxy.query(OCC_SQL, ['scope-1', 'entity-1', 'HASH-A', '{"t":"a"}', 'task_spawned']);
    await shadow.proxy.query(OCC_SQL, ['scope-1', 'entity-2', 'HASH-B', '{"t":"b"}', 'memory_updated']);
    await shadow.proxy.query('SELECT 1', []);

    expect(shadow.getEntries()).toHaveLength(2);
    expect(real.calls).toHaveLength(1);
  });

  it('clear() resets entries to empty', async () => {
    const shadow = new InMemoryShadowAdapter(makeRealPool());
    await shadow.proxy.query(OCC_SQL, ['s', 'e', 'h', 'c', 'task_spawned']);
    expect(shadow.getEntries()).toHaveLength(1);
    shadow.clear();
    expect(shadow.getEntries()).toHaveLength(0);
  });

  it('DO NOTHING OCC variant is also intercepted', async () => {
    const real = makeRealPool();
    const shadow = new InMemoryShadowAdapter(real);
    await shadow.proxy.query(DO_NOTHING_SQL, ['scope-1', 'entity-4', 'HASH-C', '{"memo":"idempotent"}']);

    expect(real.calls).toHaveLength(0);
    expect(shadow.getEntries()).toHaveLength(1);
  });

  it('spies on a mock pool with vi.fn()', async () => {
    const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const shadow = new InMemoryShadowAdapter({ query: mockQuery });

    await shadow.proxy.query(OCC_SQL, ['s', 'e', 'h', 'c', 'task_spawned']);
    expect(mockQuery).not.toHaveBeenCalled();

    await shadow.proxy.query('SELECT 1');
    expect(mockQuery).toHaveBeenCalledOnce();
  });
});
