import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  bindCategory,
  buildCapabilityEndorsement,
  capabilityStats,
  categoryEntityId,
  implementationEntityId,
  recordActivation,
  resolveBindings,
  toolEntityId,
} from './graph.js';

/** Pool stub: returns queued results in order; records every (sql, params). */
function makePool(results: Array<{ rows: unknown[] }>): {
  pool: Pool;
  calls: Array<{ sql: string; params: unknown[] | undefined }>;
} {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  let i = 0;
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return results[Math.min(i++, results.length - 1)] ?? { rows: [] };
    }),
  } as unknown as Pool;
  return { pool, calls };
}

describe('deterministic entity ids', () => {
  it('category/implementation/tool ids are stable and namespaced apart', () => {
    expect(categoryEntityId('browser')).toBe(categoryEntityId('browser'));
    expect(implementationEntityId('browser')).not.toBe(categoryEntityId('browser'));
    expect(toolEntityId('a', 'b')).not.toBe(implementationEntityId('a'));
  });
});

describe('bindCategory', () => {
  it('writes the ledger event AND upserts the read model', async () => {
    const { pool, calls } = makePool([{ rows: [] }, { rows: [] }, { rows: [] }]);
    await bindCategory(pool, 'scope-1', 'browser', 'agent-browser');
    const sqls = calls.map((c) => c.sql).join('\n');
    expect(sqls).toContain('INSERT INTO execution_event_log'); // via writeInfraEvent
    expect(sqls).toContain('INSERT INTO capability_binding');
    const bindingCall = calls.find((c) => c.sql.includes('capability_binding'))!;
    expect(bindingCall.params).toEqual(['browser', 'agent-browser']);
  });
});

describe('recordActivation / resolveBindings / capabilityStats', () => {
  it('recordActivation is idempotent by SQL shape (ON CONFLICT DO NOTHING)', async () => {
    const { pool, calls } = makePool([{ rows: [] }]);
    await recordActivation(pool, 'scope-1', 'github');
    expect(calls[0]!.sql).toContain('ON CONFLICT DO NOTHING');
  });

  it('resolveBindings maps rows to a record', async () => {
    const { pool } = makePool([
      { rows: [{ category: 'browser', implementation: 'agent-browser' }] },
    ]);
    expect(await resolveBindings(pool)).toEqual({ browser: 'agent-browser' });
  });

  it('capabilityStats coerces counts and orders by success', async () => {
    const { pool, calls } = makePool([
      {
        rows: [
          { implementation: 'github', activations: '5', successes: '4', last_used: '2026-06-12T00:00:00Z' },
        ],
      },
    ]);
    const stats = await capabilityStats(pool);
    expect(stats).toEqual([
      { implementation: 'github', activations: 5, successes: 4, last_used: '2026-06-12T00:00:00Z' },
    ]);
    expect(calls[0]!.sql).toContain("sl.status = 'closed'");
  });
});

describe('buildCapabilityEndorsement', () => {
  it('null when nothing to say', async () => {
    const { pool } = makePool([{ rows: [] }, { rows: [] }]);
    expect(await buildCapabilityEndorsement(pool)).toBeNull();
  });

  it('renders bindings + ranked stats compactly', async () => {
    // Promise.all order: capabilityStats first, resolveBindings second
    const { pool } = makePool([
      { rows: [{ implementation: 'github', activations: '3', successes: '2', last_used: '2026-06-11T10:00:00Z' }] },
      { rows: [{ category: 'browser', implementation: 'agent-browser' }] },
    ]);
    const block = await buildCapabilityEndorsement(pool);
    expect(block).toContain('[capabilities]');
    expect(block).toContain('browser -> agent-browser (bound)');
    expect(block).toContain('github: 2/3 converged, last 2026-06-11');
  });

  it('null (not throw) when the tables are missing', async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error('relation "capability_activation" does not exist');
      }),
    } as unknown as Pool;
    expect(await buildCapabilityEndorsement(pool)).toBeNull();
  });
});
