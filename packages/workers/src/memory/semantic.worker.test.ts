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

import { occWrite } from '@graph/shared';
import { SemanticMemoryWorker, SEMANTIC_TRIGGER_CONFIG } from './semantic.worker.js';

describe('SemanticMemoryWorker', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let pool: Pool;
  let mockChat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChat = vi.fn().mockResolvedValue('distilled fact');
    mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ content: 'trace data' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    pool = { query: mockQuery } as unknown as Pool;
  });

  it('queries episodic_memory for the scope and calls llm.chat with combined content', async () => {
    const worker = new SemanticMemoryWorker(pool, { chat: mockChat });
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('episodic_memory'),
      ['scope-1'],
    );
    expect(mockChat).toHaveBeenCalledOnce();
  });

  it('inserts exactly one row into semantic_memory with writeGuard(llmOutput)', async () => {
    const worker = new SemanticMemoryWorker(pool, { chat: mockChat });
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('semantic_memory'),
      expect.arrayContaining(['[guarded]:distilled fact']),
    );
  });

  it('calls occWrite exactly once with eventType memory_updated after INSERT', async () => {
    const worker = new SemanticMemoryWorker(pool, { chat: mockChat });
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(vi.mocked(occWrite)).toHaveBeenCalledOnce();
    expect(vi.mocked(occWrite)).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ eventType: 'memory_updated' }),
    );
  });

  it('returns early without INSERT or occWrite when episodic_memory returns 0 rows', async () => {
    const emptyQuery = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const emptyPool = { query: emptyQuery } as unknown as Pool;
    const worker = new SemanticMemoryWorker(emptyPool, { chat: mockChat });

    await worker.onScopeClosed('scope-empty', 'entity-1', '0'.repeat(64));

    expect(emptyQuery).toHaveBeenCalledOnce();
    expect(mockChat).not.toHaveBeenCalled();
    expect(vi.mocked(occWrite)).not.toHaveBeenCalled();
  });

  it('SEMANTIC_TRIGGER_CONFIG has durable:subscriber type, correct function_id, and topic', () => {
    expect(SEMANTIC_TRIGGER_CONFIG.type).toBe('durable:subscriber');
    expect(SEMANTIC_TRIGGER_CONFIG.function_id).toBe('graph::memory::semantic');
    expect(SEMANTIC_TRIGGER_CONFIG.config.topic).toBe('graph::scope::closed');
  });
});
