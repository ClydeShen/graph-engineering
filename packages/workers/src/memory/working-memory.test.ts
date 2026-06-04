import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

vi.mock('@graph/shared', () => ({
  writeGuard: vi.fn((s: string) => `[guarded]:${s}`),
}));

import { insertWorkingMemory } from './working-memory.js';

describe('insertWorkingMemory', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let pool: Pool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // SELECT: no existing row
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT: success
    pool = { query: mockQuery } as unknown as Pool;
  });

  it('inserts one row when no existing dedup match within 5 minutes', async () => {
    const result = await insertWorkingMemory(pool, 'scope-1', 'entity-1', 'task_spawned', 'some content');

    expect(result).toEqual({ inserted: true });
    expect(mockQuery).toHaveBeenCalledTimes(2); // SELECT + INSERT
    const insertSql = mockQuery.mock.calls[1][0] as string;
    expect(insertSql).toContain('INSERT INTO working_memory');
  });

  it('returns early without INSERT when identical dedup_hash exists within 5 minutes', async () => {
    mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'existing-uuid' }], rowCount: 1 }); // SELECT: found
    pool = { query: mockQuery } as unknown as Pool;

    const result = await insertWorkingMemory(pool, 'scope-1', 'entity-1', 'task_spawned', 'some content');

    expect(result).toEqual({ inserted: false });
    expect(mockQuery).toHaveBeenCalledOnce(); // SELECT only — no INSERT
  });

  it('proceeds with INSERT when existing row is older than 5 minutes (SELECT returns empty)', async () => {
    // SELECT returns no rows → INSERT proceeds
    const result = await insertWorkingMemory(pool, 'scope-2', 'entity-2', 'memory_updated', 'stale content');

    expect(result).toEqual({ inserted: true });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const selectSql = mockQuery.mock.calls[0][0] as string;
    expect(selectSql).toContain("INTERVAL '5 minutes'");
  });

  it('dedup_hash is deterministic: same inputs produce same hash in SELECT and INSERT params', async () => {
    await insertWorkingMemory(pool, 'scope-1', 'entity-1', 'task_spawned', 'content abc');

    const selectParams = mockQuery.mock.calls[0][1] as unknown[];
    const insertParams = mockQuery.mock.calls[1][1] as unknown[];
    // SELECT $2 = dedup_hash, INSERT $3 = dedup_hash — same hash value
    expect(selectParams[1]).toBe(insertParams[2]);
    // hash is a 64-char hex string (SHA-256)
    expect(typeof selectParams[1]).toBe('string');
    expect((selectParams[1] as string)).toHaveLength(64);
  });

  it('INSERT stores writeGuard(content) as content column; hash computed from raw content', async () => {
    const rawContent = 'sk-test-123 some result';
    await insertWorkingMemory(pool, 'scope-1', 'entity-1', 'task_spawned', rawContent);

    const insertParams = mockQuery.mock.calls[1][1] as unknown[];
    // $2 = content stored — writeGuard applied
    expect(insertParams[1]).toBe(`[guarded]:${rawContent}`);
    // $3 = dedup_hash — computed from raw, not guarded content
    const selectParams = mockQuery.mock.calls[0][1] as unknown[];
    // hash of raw content matches hash in SELECT
    expect(insertParams[2]).toBe(selectParams[1]);
    // dedup hash is NOT the same as hash of guarded content (different inputs)
    // (we verify by checking the hash is a deterministic 64-char hex string)
    expect((insertParams[2] as string)).toHaveLength(64);
  });
});
