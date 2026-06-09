import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventWriter } from '@graph/shared';
import { StubTrailReader } from '../base/trail-reader.js';
import { StubMemoryRepository } from '../base/memory-repository.js';

vi.mock('@graph/shared', () => ({
  writeGuard: vi.fn((s: string) => `[guarded]:${s}`),
}));

import { SemanticMemoryWorker, SEMANTIC_TRIGGER_CONFIG } from './semantic.worker.js';

function makeWriter(): EventWriter & { write: ReturnType<typeof vi.fn> } {
  return {
    write: vi.fn().mockResolvedValue({
      version_hash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
      event_type: 'memory_updated',
      occ_result: 'won',
    }),
  };
}

describe('SemanticMemoryWorker', () => {
  let reader: StubTrailReader;
  let memory: StubMemoryRepository;
  let writer: ReturnType<typeof makeWriter>;
  let mockChat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChat = vi.fn().mockResolvedValue('distilled fact');
    reader = new StubTrailReader();
    vi.spyOn(reader, 'getEpisodicRecords').mockResolvedValue(['trace data']);
    memory = new StubMemoryRepository();
    writer = makeWriter();
  });

  it('reads episodic records for the scope and calls llm.chat with combined content', async () => {
    const worker = new SemanticMemoryWorker(reader, memory, writer, { chat: mockChat });
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(reader.getEpisodicRecords).toHaveBeenCalledWith('scope-1', { limit: 50 });
    expect(mockChat).toHaveBeenCalledOnce();
  });

  it('inserts one semantic fact with writeGuard(llmOutput) via memory repository', async () => {
    const worker = new SemanticMemoryWorker(reader, memory, writer, { chat: mockChat });
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(memory.calls.insertSemanticFact).toHaveLength(1);
    expect(memory.calls.insertSemanticFact[0]).toMatchObject({
      scopeId: 'scope-1',
      content: '[guarded]:distilled fact',
    });
  });

  it('calls writes.write exactly once with eventType memory_updated after insert', async () => {
    const worker = new SemanticMemoryWorker(reader, memory, writer, { chat: mockChat });
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(writer.write).toHaveBeenCalledOnce();
    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'memory_updated' }),
    );
  });

  it('returns early without insert or write when episodic records are empty', async () => {
    const emptyReader = new StubTrailReader();
    const worker = new SemanticMemoryWorker(emptyReader, memory, writer, { chat: mockChat });

    await worker.onScopeClosed('scope-empty', 'entity-1', '0'.repeat(64));

    expect(mockChat).not.toHaveBeenCalled();
    expect(memory.calls.insertSemanticFact).toHaveLength(0);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('SEMANTIC_TRIGGER_CONFIG has durable:subscriber type, correct function_id, and topic', () => {
    expect(SEMANTIC_TRIGGER_CONFIG.type).toBe('durable:subscriber');
    expect(SEMANTIC_TRIGGER_CONFIG.function_id).toBe('graph::memory::semantic');
    expect(SEMANTIC_TRIGGER_CONFIG.config.topic).toBe('graph::scope::closed');
  });
});
