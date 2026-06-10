import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventWriter } from '@graph/shared';
import { StubMemoryRepository } from '../base/memory-repository.js';

vi.mock('@graph/shared', () => ({
  writeGuard: vi.fn((s: string) => `[guarded]:${s}`),
  contentFingerprint: vi.fn((s: string) => `fp:${s}`),
}));

import { EpisodicMemoryWorker, EPISODIC_TRIGGER_CONFIG } from './episodic.worker.js';

function makeWriter(): EventWriter & { write: ReturnType<typeof vi.fn> } {
  return {
    write: vi.fn().mockResolvedValue({
      version_hash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
      event_type: 'memory_updated',
      occ_result: 'won',
    }),
  };
}

describe('EpisodicMemoryWorker', () => {
  let memory: StubMemoryRepository;
  let writer: ReturnType<typeof makeWriter>;

  beforeEach(() => {
    vi.clearAllMocks();
    memory = new StubMemoryRepository();
    writer = makeWriter();
  });

  it('appends exactly one episodic trace via memory repository', async () => {
    const worker = new EpisodicMemoryWorker(memory, writer);
    await worker.onEvent('scope-1', 'entity-1', 'test content', '0'.repeat(64));

    expect(memory.calls.appendEpisodicTrace).toHaveLength(1);
    expect(memory.calls.appendEpisodicTrace[0]).toMatchObject({ scopeId: 'scope-1', entityId: 'entity-1' });
  });

  it('calls writes.write exactly once with eventType memory_updated', async () => {
    const worker = new EpisodicMemoryWorker(memory, writer);
    await worker.onEvent('scope-1', 'entity-1', 'content', '0'.repeat(64));

    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'memory_updated' }),
    );
  });

  it('passes writeGuard(content) to memory, not raw content', async () => {
    const worker = new EpisodicMemoryWorker(memory, writer);
    const rawContent = 'my key is sk-test-123';
    await worker.onEvent('scope-1', 'entity-1', rawContent, '0'.repeat(64));

    expect(memory.calls.appendEpisodicTrace[0].content).toBe('[guarded]:my key is sk-test-123');
    expect(memory.calls.appendEpisodicTrace[0].content).not.toBe(rawContent);
  });

  it('passes scopeId, entityId, and guarded content as the three trace fields', async () => {
    const worker = new EpisodicMemoryWorker(memory, writer);
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
