import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

vi.mock('@graph/shared', () => ({
  writeGuard: vi.fn((s: string) => `[guarded]:${s}`),
  occWrite: vi.fn().mockResolvedValue({
    version_hash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
    event_type: 'memory_updated',
    occ_result: 'won',
  }),
}));

import { writeGuard, occWrite } from '@graph/shared';
import { EpisodicMemoryWorker, EPISODIC_TRIGGER_CONFIG } from './episodic.worker.js';

describe('EpisodicMemoryWorker', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let pool: Pool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    pool = { query: mockQuery } as unknown as Pool;
  });

  it('inserts exactly one row into episodic_memory', async () => {
    const worker = new EpisodicMemoryWorker(pool);
    await worker.onEvent('scope-1', 'entity-1', 'test content', '0'.repeat(64));

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO episodic_memory'),
      expect.any(Array),
    );
  });

  it('calls occWrite exactly once with eventType memory_updated', async () => {
    const worker = new EpisodicMemoryWorker(pool);
    await worker.onEvent('scope-1', 'entity-1', 'content', '0'.repeat(64));

    expect(vi.mocked(occWrite)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(occWrite)).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ eventType: 'memory_updated' }),
    );
  });

  it('stores writeGuard(content) as the third INSERT param, not raw content', async () => {
    const worker = new EpisodicMemoryWorker(pool);
    const rawContent = 'my key is sk-test-123';
    await worker.onEvent('scope-1', 'entity-1', rawContent, '0'.repeat(64));

    const [, params] = mockQuery.mock.calls[0] as [string, string[]];
    expect(params[2]).toBe('[guarded]:my key is sk-test-123');
    expect(params[2]).not.toBe(rawContent);
  });

  it('does not pass ts_doc to INSERT (GENERATED ALWAYS column)', async () => {
    const worker = new EpisodicMemoryWorker(pool);
    await worker.onEvent('scope-1', 'entity-1', 'content', '0'.repeat(64));

    const [sql, params] = mockQuery.mock.calls[0] as [string, string[]];
    expect(sql).not.toContain('ts_doc');
    expect(params).toHaveLength(3);
  });

  it('EPISODIC_TRIGGER_CONFIG has durable:subscriber type, correct function_id, and topic', () => {
    expect(EPISODIC_TRIGGER_CONFIG.type).toBe('durable:subscriber');
    expect(EPISODIC_TRIGGER_CONFIG.function_id).toBe('graph::memory::episodic');
    expect(EPISODIC_TRIGGER_CONFIG.config.topic).toBe('graph::memory::episodic::ingest');
  });
});
