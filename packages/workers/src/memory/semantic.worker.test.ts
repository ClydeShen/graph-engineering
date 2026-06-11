import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventWriter, EmbeddingProvider } from '@graph/shared';
import { StubTrailReader } from '../base/trail-reader.js';
import { StubMemoryRepository } from '../base/memory-repository.js';

vi.mock('@graph/shared', () => ({
  writeGuard: vi.fn((s: string) => `[guarded]:${s}`),
  contentFingerprint: vi.fn((s: string) => `fp:${s}`),
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

function makeEmbed(): EmbeddingProvider & { embed: ReturnType<typeof vi.fn> } {
  return {
    embed: vi.fn().mockResolvedValue({ vector: Array(1536).fill(0.1), countedAgainstBudget: false }),
  };
}

describe('SemanticMemoryWorker', () => {
  let reader: StubTrailReader;
  let memory: StubMemoryRepository;
  let writer: ReturnType<typeof makeWriter>;
  let mockChat: ReturnType<typeof vi.fn>;
  let embed: ReturnType<typeof makeEmbed>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChat = vi.fn().mockResolvedValue('distilled fact');
    reader = new StubTrailReader();
    vi.spyOn(reader, 'getEpisodicRecords').mockResolvedValue(['trace data']);
    memory = new StubMemoryRepository();
    writer = makeWriter();
    embed = makeEmbed();
  });

  it('reads episodic records for the scope and calls llm.chat with combined content', async () => {
    const worker = new SemanticMemoryWorker(reader, memory, writer, { chat: mockChat }, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(reader.getEpisodicRecords).toHaveBeenCalledWith('scope-1', { limit: 50 });
    expect(mockChat).toHaveBeenCalledOnce();
  });

  it('inserts one semantic fact with writeGuard(llmOutput) via memory repository', async () => {
    const worker = new SemanticMemoryWorker(reader, memory, writer, { chat: mockChat }, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(memory.calls.insertSemanticFact).toHaveLength(1);
    expect(memory.calls.insertSemanticFact[0]).toMatchObject({
      scopeId: 'scope-1',
      content: '[guarded]:distilled fact',
    });
  });

  it('calls writes.write exactly once with eventType memory_updated after insert', async () => {
    const worker = new SemanticMemoryWorker(reader, memory, writer, { chat: mockChat }, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(writer.write).toHaveBeenCalledOnce();
    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'memory_updated' }),
    );
  });

  it('returns early without insert or write when episodic records are empty', async () => {
    const emptyReader = new StubTrailReader();
    const worker = new SemanticMemoryWorker(emptyReader, memory, writer, { chat: mockChat }, embed);

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

  it('calls supersede(suggestedMerge.id, newId) when insertSemanticFact returns a suggestedMerge', async () => {
    memory.setSuggestedMergeResult({ id: 'existing-id', content: 'existing fact' });
    const worker = new SemanticMemoryWorker(reader, memory, writer, { chat: mockChat }, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(memory.calls.supersede).toHaveLength(1);
    expect(memory.calls.supersede[0]).toEqual({ oldId: 'existing-id', newId: 'stub-id' });
  });

  it('does NOT call supersede when insertSemanticFact returns suggestedMerge: null', async () => {
    // Default stub returns suggestedMerge: null
    const worker = new SemanticMemoryWorker(reader, memory, writer, { chat: mockChat }, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(memory.calls.supersede).toHaveLength(0);
  });

  it('passes writeGuard(fact) as first argument to embed.embed', async () => {
    const worker = new SemanticMemoryWorker(reader, memory, writer, { chat: mockChat }, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(embed.embed).toHaveBeenCalledWith('[guarded]:distilled fact');
  });

  it('passes vector from embed.embed to insertSemanticFact as third argument', async () => {
    const worker = new SemanticMemoryWorker(reader, memory, writer, { chat: mockChat }, embed);
    await worker.onScopeClosed('scope-1', 'entity-1', '0'.repeat(64));

    expect(memory.calls.insertSemanticFact[0].embedding).toEqual(Array(1536).fill(0.1));
  });
});
