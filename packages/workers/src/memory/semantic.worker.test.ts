import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { StubTrailReader } from '../base/trail-reader.js';

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
  let reader: StubTrailReader;
  let pool: Pool;
  let mockChat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChat = vi.fn().mockResolvedValue('distilled fact');
    reader = new StubTrailReader();
    vi.spyOn(reader, 'getEpisodicRecords').mockResolvedValue(['trace data']);
    pool = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) } as unknown as Pool;
  });

  it('reads episodic records for the scope and calls llm.chat with combined content', async () => {
    const worker = new SemanticMemoryWorker(reader, pool, { chat: mockChat });
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(reader.getEpisodicRecords).toHaveBeenCalledWith('scope-1', { limit: 50 });
    expect(mockChat).toHaveBeenCalledOnce();
  });

  it('inserts exactly one row into semantic_memory with writeGuard(llmOutput)', async () => {
    const worker = new SemanticMemoryWorker(reader, pool, { chat: mockChat });
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('semantic_memory'),
      expect.arrayContaining(['[guarded]:distilled fact']),
    );
  });

  it('calls occWrite exactly once with eventType memory_updated after INSERT', async () => {
    const worker = new SemanticMemoryWorker(reader, pool, { chat: mockChat });
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(vi.mocked(occWrite)).toHaveBeenCalledOnce();
    expect(vi.mocked(occWrite)).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ eventType: 'memory_updated' }),
    );
  });

  it('returns early without INSERT or occWrite when episodic records are empty', async () => {
    const emptyReader = new StubTrailReader(); // returns [] by default
    const worker = new SemanticMemoryWorker(emptyReader, pool, { chat: mockChat });

    await worker.onScopeClosed('scope-empty', 'entity-1', '0'.repeat(64));

    expect(mockChat).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(vi.mocked(occWrite)).not.toHaveBeenCalled();
  });

  it('SEMANTIC_TRIGGER_CONFIG has durable:subscriber type, correct function_id, and topic', () => {
    expect(SEMANTIC_TRIGGER_CONFIG.type).toBe('durable:subscriber');
    expect(SEMANTIC_TRIGGER_CONFIG.function_id).toBe('graph::memory::semantic');
    expect(SEMANTIC_TRIGGER_CONFIG.config.topic).toBe('graph::scope::closed');
  });
});
