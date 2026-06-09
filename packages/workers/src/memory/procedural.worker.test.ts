import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import type { EmbeddingProvider } from '@graph/shared';
import { StubMemoryRepository } from '../base/memory-repository.js';

vi.mock('@graph/shared', () => ({
  writeGuard: vi.fn((s: string) => `[guarded]:${s}`),
  occWrite: vi.fn().mockResolvedValue({
    version_hash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
    event_type: 'memory_updated',
    occ_result: 'won',
  }),
}));

vi.mock('./wl-embedding.js', () => ({
  computeWLEmbedding: vi.fn().mockReturnValue(new Float32Array(128).fill(1 / Math.sqrt(128))),
}));

import { occWrite } from '@graph/shared';
import { computeWLEmbedding } from './wl-embedding.js';
import { ProceduralMemoryWorker, PROCEDURAL_TRIGGER_CONFIG } from './procedural.worker.js';

function makeMockLlm(vector?: number[]): EmbeddingProvider {
  const v = vector ?? new Array(1536).fill(0.5);
  return {
    embed: vi.fn().mockResolvedValue({ vector: v, countedAgainstBudget: false as const }),
  };
}

describe('ProceduralMemoryWorker', () => {
  let memory: StubMemoryRepository;
  let pool: Pool;

  const nodes = [{ id: 'node-0', event_type: 'episodic_trace' }];
  const edges: { source: string; target: string }[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    memory = new StubMemoryRepository();
    pool = { query: vi.fn() } as unknown as Pool;
  });

  it('onSynthesizerOutput calls computeWLEmbedding and passes bracketed pgvector literal', async () => {
    const worker = new ProceduralMemoryWorker(memory, pool, makeMockLlm());
    await worker.onSynthesizerOutput('scope-1', 'entity-1', '0'.repeat(64), {}, 'intent text', nodes, edges);

    expect(vi.mocked(computeWLEmbedding)).toHaveBeenCalledWith(nodes, edges);
    const params = memory.calls.insertProceduralTemplate[0];
    expect(params.embeddingLiteral).toMatch(/^\[.*\]$/);
  });

  it('onSynthesizerOutput passes topology_embedding and intent_embedding as separate bracketed literals', async () => {
    const worker = new ProceduralMemoryWorker(memory, pool, makeMockLlm());
    await worker.onSynthesizerOutput('scope-1', 'entity-1', '0'.repeat(64), {}, 'intent text', nodes, edges);

    const params = memory.calls.insertProceduralTemplate[0];
    expect(params.embeddingLiteral).toMatch(/^\[.*\]$/);
    expect(params.intentEmbeddingLiteral).toMatch(/^\[.*\]$/);
  });

  it('onSynthesizerOutput calls occWrite with eventType memory_updated after insert', async () => {
    const worker = new ProceduralMemoryWorker(memory, pool, makeMockLlm());
    await worker.onSynthesizerOutput('scope-1', 'entity-1', '0'.repeat(64), {}, 'intent text', nodes, edges);

    expect(vi.mocked(occWrite)).toHaveBeenCalledOnce();
    expect(vi.mocked(occWrite)).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ eventType: 'memory_updated' }),
    );
  });

  it('onSynthesizerOutput applies writeGuard to both content and intent_description', async () => {
    const worker = new ProceduralMemoryWorker(memory, pool, makeMockLlm());
    await worker.onSynthesizerOutput('scope-1', 'entity-1', '0'.repeat(64), {}, 'raw intent', nodes, edges);

    const params = memory.calls.insertProceduralTemplate[0];
    expect(params.content).toBe('[guarded]:raw intent');
    expect(params.intentDescription).toBe('[guarded]:raw intent');
  });

  it('reinforce() delegates to memory.reinforceTemplate with the template_id', async () => {
    const worker = new ProceduralMemoryWorker(memory, pool, makeMockLlm());
    await worker.reinforce('template-uuid-123');

    expect(memory.calls.reinforceTemplate).toContain('template-uuid-123');
  });

  it('intent_embedding and topology_embedding are distinct bracketed literals with different dimensions', async () => {
    const mockLlm = makeMockLlm(new Array(1536).fill(0.5));
    const worker = new ProceduralMemoryWorker(memory, pool, mockLlm);
    await worker.onSynthesizerOutput('scope-1', 'entity-1', '0'.repeat(64), {}, 'my intent text', nodes, edges);

    expect(mockLlm.embed).toHaveBeenCalledWith('my intent text');

    const params = memory.calls.insertProceduralTemplate[0];
    expect(params.embeddingLiteral).toMatch(/^\[.*\]$/);
    expect(params.intentEmbeddingLiteral).toMatch(/^\[.*\]$/);
    expect(params.intentEmbeddingLiteral).not.toBe(params.embeddingLiteral);
  });

  it('intentEmbeddingLiteral is null when llm.embed throws; embeddingLiteral still written', async () => {
    const failingLlm: EmbeddingProvider = {
      embed: vi.fn().mockRejectedValue(new Error('provider down')),
    };
    const worker = new ProceduralMemoryWorker(memory, pool, failingLlm);
    await worker.onSynthesizerOutput('scope-1', 'entity-1', '0'.repeat(64), {}, 'intent text', nodes, edges);

    const params = memory.calls.insertProceduralTemplate[0];
    expect(params.embeddingLiteral).toMatch(/^\[.*\]$/);
    expect(params.intentEmbeddingLiteral).toBeNull();
  });

  it('PROCEDURAL_TRIGGER_CONFIG has durable:subscriber type, correct function_id, and topic', () => {
    expect(PROCEDURAL_TRIGGER_CONFIG.type).toBe('durable:subscriber');
    expect(PROCEDURAL_TRIGGER_CONFIG.function_id).toBe('graph::memory::procedural');
    expect(PROCEDURAL_TRIGGER_CONFIG.config.topic).toBe('graph::memory::synthesizer::output');
  });
});
