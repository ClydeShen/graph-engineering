import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { StubMemoryRepository } from '../base/memory-repository.js';

vi.mock('@graph/shared', () => ({
  writeGuard: vi.fn((s: string) => `[guarded]:${s}`),
  occWrite: vi.fn().mockResolvedValue({
    version_hash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
    event_type: 'memory_updated',
    occ_result: 'won',
  }),
}));

import { occWrite } from '@graph/shared';
import { EpisodicMemoryWorker, EPISODIC_TRIGGER_CONFIG } from './episodic.worker.js';

describe('EpisodicMemoryWorker', () => {
  let memory: StubMemoryRepository;
  let pool: Pool;

  beforeEach(() => {
    vi.clearAllMocks();
    memory = new StubMemoryRepository();
    pool = { query: vi.fn() } as unknown as Pool;
  });

  it('appends exactly one episodic trace via memory repository', async () => {
    const worker = new EpisodicMemoryWorker(memory, pool);
    await worker.onEvent('scope-1', 'entity-1', 'test content', '0'.repeat(64));

    expect(memory.calls.appendEpisodicTrace).toHaveLength(1);
    expect(memory.calls.appendEpisodicTrace[0]).toMatchObject({ scopeId: 'scope-1', entityId: 'entity-1' });
  });

  it('calls occWrite exactly once with eventType memory_updated', async () => {
    const worker = new EpisodicMemoryWorker(memory, pool);
    await worker.onEvent('scope-1', 'entity-1', 'content', '0'.repeat(64));

    expect(vi.mocked(occWrite)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(occWrite)).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ eventType: 'memory_updated' }),
    );
  });

  it('passes writeGuard(content) to memory, not raw content', async () => {
    const worker = new EpisodicMemoryWorker(memory, pool);
    const rawContent = 'my key is sk-test-123';
    await worker.onEvent('scope-1', 'entity-1', rawContent, '0'.repeat(64));

    expect(memory.calls.appendEpisodicTrace[0].content).toBe('[guarded]:my key is sk-test-123');
    expect(memory.calls.appendEpisodicTrace[0].content).not.toBe(rawContent);
  });

  it('passes scopeId, entityId, and guarded content as the three trace fields', async () => {
    const worker = new EpisodicMemoryWorker(memory, pool);
    await worker.onEvent('scope-x', 'entity-y', 'data', '0'.repeat(64));

    const trace = memory.calls.appendEpisodicTrace[0];
    expect(Object.keys(trace)).toEqual(['scopeId', 'entityId', 'content']);
    expect(trace.scopeId).toBe('scope-x');
    expect(trace.entityId).toBe('entity-y');
  });

  it('EPISODIC_TRIGGER_CONFIG has durable:subscriber type, correct function_id, and topic', () => {
    expect(EPISODIC_TRIGGER_CONFIG.type).toBe('durable:subscriber');
    expect(EPISODIC_TRIGGER_CONFIG.function_id).toBe('graph::memory::episodic');
    expect(EPISODIC_TRIGGER_CONFIG.config.topic).toBe('graph::memory::episodic::ingest');
  });
});
