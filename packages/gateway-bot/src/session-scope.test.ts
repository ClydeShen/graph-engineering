/**
 * session-scope.test.ts — TD-E stable session→scope mapping (Phase 11 DoD G1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

const mockWriteInfraEvent = vi.fn().mockResolvedValue(undefined);
const mockNestScope = vi.fn().mockResolvedValue({
  scopeId: 'fresh-scope-id',
  planHash: 'p'.repeat(64),
});

vi.mock('@graph/shared', () => ({
  writeInfraEvent: (...a: unknown[]) => mockWriteInfraEvent(...a),
  canonicalJson: (v: unknown) => JSON.stringify(v),
}));
vi.mock('@graph/control-plane/nesting', () => ({
  nestScope: (...a: unknown[]) => mockNestScope(...a),
}));

import { resolveSessionScope, resolveScopeTip, sessionIntent } from './session-scope.js';

/** Pool whose client.query dispatches on SQL shape. */
function makePool(opts: {
  liveScope?: string;
  tipHash?: string;
  tipAgeMs?: number;
}): { pool: Pool; queries: string[] } {
  const queries: string[] = [];
  const query = vi.fn((sql: string, _params?: unknown[]) => {
    queries.push(sql);
    if (sql.includes('pg_advisory')) return Promise.resolve({ rows: [] });
    if (sql.includes('FROM scope_lineage')) {
      return Promise.resolve({
        rows: opts.liveScope ? [{ scope_id: opts.liveScope }] : [],
      });
    }
    if (sql.includes('FROM execution_event_log')) {
      return Promise.resolve({
        rows: opts.tipHash
          ? [{ version_hash: opts.tipHash, created_at: new Date(Date.now() - (opts.tipAgeMs ?? 0)) }]
          : [],
      });
    }
    return Promise.resolve({ rows: [] });
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn().mockResolvedValue(client), query } as unknown as Pool;
  return { pool, queries };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveSessionScope (TD-E)', () => {
  it('reuses the live session scope and returns its tip hash as predecessor', async () => {
    const { pool } = makePool({ liveScope: 'scope-live', tipHash: 't'.repeat(64), tipAgeMs: 1000 });
    const result = await resolveSessionScope(pool, 'telegram::123');

    expect(result).toEqual({ scopeId: 'scope-live', predecessorHash: 't'.repeat(64), resumed: true });
    expect(mockNestScope).not.toHaveBeenCalled();
  });

  it('creates a fresh scope via nestScope when no live session scope exists', async () => {
    const { pool } = makePool({});
    const result = await resolveSessionScope(pool, 'telegram::123');

    expect(mockNestScope).toHaveBeenCalledWith(pool, sessionIntent('telegram::123'));
    expect(result).toEqual({ scopeId: 'fresh-scope-id', predecessorHash: 'p'.repeat(64), resumed: false });
  });

  it('idle-expired scope is closed (scope_closed infra event) and a fresh one opened', async () => {
    const { pool } = makePool({
      liveScope: 'scope-stale',
      tipHash: 't'.repeat(64),
      tipAgeMs: 60 * 60 * 1000, // 1h > 30min default
    });
    const result = await resolveSessionScope(pool, 'telegram::123');

    expect(mockWriteInfraEvent).toHaveBeenCalledWith(
      pool,
      'scope-stale',
      'scope_closed',
      expect.stringContaining('session_idle_timeout'),
      'terminated',
    );
    expect(result.resumed).toBe(false);
    expect(result.scopeId).toBe('fresh-scope-id');
  });

  it('acquires and releases the advisory lock around the resolution', async () => {
    const { pool, queries } = makePool({});
    await resolveSessionScope(pool, 'telegram::123');

    expect(queries.some((q) => q.includes('pg_advisory_lock'))).toBe(true);
    expect(queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('custom idle timeout is honored', async () => {
    const { pool } = makePool({ liveScope: 'scope-live', tipHash: 't'.repeat(64), tipAgeMs: 5000 });
    // 5s age with a 1s timeout → expired → fresh scope
    const result = await resolveSessionScope(pool, 'k', 1000);
    expect(result.resumed).toBe(false);
  });
});

describe('resolveScopeTip (Phase 12 cross-platform continuation)', () => {
  function tipPool(opts: { status?: string; tipHash?: string }): Pool {
    const query = vi.fn((sql: string) => {
      if (sql.includes('SELECT status FROM scope_lineage')) {
        return Promise.resolve({ rows: opts.status ? [{ status: opts.status }] : [] });
      }
      if (sql.includes('FROM execution_event_log')) {
        return Promise.resolve({ rows: opts.tipHash ? [{ version_hash: opts.tipHash }] : [] });
      }
      return Promise.resolve({ rows: [] });
    });
    return { query } as unknown as Pool;
  }

  it('returns the live scope tip so any channel can continue the same Trail', async () => {
    const result = await resolveScopeTip(tipPool({ status: 'active', tipHash: 'z'.repeat(64) }), 'scope-x');
    expect(result).toEqual({ scopeId: 'scope-x', predecessorHash: 'z'.repeat(64) });
  });

  it('returns null for closed or unknown scopes', async () => {
    expect(await resolveScopeTip(tipPool({ status: 'closed', tipHash: 'z'.repeat(64) }), 's')).toBeNull();
    expect(await resolveScopeTip(tipPool({}), 's')).toBeNull();
  });
});
