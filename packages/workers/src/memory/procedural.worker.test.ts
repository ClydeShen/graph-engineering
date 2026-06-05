import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import type { EmbeddingProvider } from '@graph/shared';

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

/** Helper: build a mock EmbeddingProvider returning a 1536-dim vector. */
function makeMockLlm(vector?: number[]): EmbeddingProvider {
  const v = vector ?? new Array(1536).fill(0.5);
  return {
    embed: vi.fn().mockResolvedValue({ vector: v, countedAgainstBudget: false as const }),
  };
}

describe('ProceduralMemoryWorker', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let pool: Pool;

  const nodes = [{ id: 'node-0', event_type: 'episodic_trace' }];
  const edges: { source: string; target: string }[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    pool = { query: mockQuery } as unknown as Pool;
  });

  it('onSynthesizerOutput calls computeWLEmbedding and includes vector as bracketed pgvector literal in params', async () => {
    const worker = new ProceduralMemoryWorker(pool, makeMockLlm());
    await worker.onSynthesizerOutput('scope-1', 'entity-1', '0'.repeat(64), {}, 'intent text', nodes, edges);

    expect(vi.mocked(computeWLEmbedding)).toHaveBeenCalledWith(nodes, edges);
    const params = mockQuery.mock.calls[0][1] as unknown[];
    const embeddingParam = params.find(
      (p): p is string => typeof p === 'string' && p.startsWith('[') && p.endsWith(']'),
    );
    expect(embeddingParam).toBeDefined();
  });

  it('onSynthesizerOutput inserts into procedural_memory with topology_embedding as $5 and intent_embedding as $6', async () => {
    const worker = new ProceduralMemoryWorker(pool, makeMockLlm());
    await worker.onSynthesizerOutput('scope-1', 'entity-1', '0'.repeat(64), {}, 'intent text', nodes, edges);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('procedural_memory'),
      expect.anything(),
    );
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toHaveLength(6);
    // topology_embedding ($5, index 4) — WL kernel output
    expect(params[4]).toMatch(/^\[.*\]$/);
    // intent_embedding ($6, index 5) — semantic embedding (non-null on success)
    expect(params[5]).toMatch(/^\[.*\]$/);
  });

  it('onSynthesizerOutput calls occWrite with eventType memory_updated after INSERT', async () => {
    const worker = new ProceduralMemoryWorker(pool, makeMockLlm());
    await worker.onSynthesizerOutput('scope-1', 'entity-1', '0'.repeat(64), {}, 'intent text', nodes, edges);

    expect(vi.mocked(occWrite)).toHaveBeenCalledOnce();
    expect(vi.mocked(occWrite)).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({ eventType: 'memory_updated' }),
    );
  });

  it('onSynthesizerOutput applies writeGuard to both content ($2) and intent_description ($3)', async () => {
    const worker = new ProceduralMemoryWorker(pool, makeMockLlm());
    await worker.onSynthesizerOutput('scope-1', 'entity-1', '0'.repeat(64), {}, 'raw intent', nodes, edges);

    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[1]).toBe('[guarded]:raw intent');
    expect(params[2]).toBe('[guarded]:raw intent');
  });

  it('reinforce() updates success_count = success_count + 1 and last_used_at for given template_id', async () => {
    const worker = new ProceduralMemoryWorker(pool, makeMockLlm());
    await worker.reinforce('template-uuid-123');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('success_count = success_count + 1'),
      ['template-uuid-123'],
    );
  });

  it('intent_embedding ($6) is a bracketed literal distinct from topology_embedding ($5), and llm.embed called with intentDescription', async () => {
    // topology mock returns 128-dim all-ones-normalized; llm returns 1536-dim all-0.5
    const mockLlm = makeMockLlm(new Array(1536).fill(0.5));
    const worker = new ProceduralMemoryWorker(pool, mockLlm);
    await worker.onSynthesizerOutput('scope-1', 'entity-1', '0'.repeat(64), {}, 'my intent text', nodes, edges);

    // llm.embed was called with the intentDescription string
    expect(mockLlm.embed).toHaveBeenCalledWith('my intent text');

    const params = mockQuery.mock.calls[0][1] as unknown[];
    const topologyLiteral = params[4] as string;
    const intentLiteral = params[5] as string;

    // Both are bracketed vector literals
    expect(topologyLiteral).toMatch(/^\[.*\]$/);
    expect(intentLiteral).toMatch(/^\[.*\]$/);

    // They are NOT the same string (topology is 128-dim WL; intent is 1536-dim semantic)
    expect(intentLiteral).not.toBe(topologyLiteral);
  });

  it('intent_embedding ($6) is null when llm.embed throws, topology_embedding ($5) still written', async () => {
    const failingLlm: EmbeddingProvider = {
      embed: vi.fn().mockRejectedValue(new Error('provider down')),
    };
    const worker = new ProceduralMemoryWorker(pool, failingLlm);
    await worker.onSynthesizerOutput('scope-1', 'entity-1', '0'.repeat(64), {}, 'intent text', nodes, edges);

    const params = mockQuery.mock.calls[0][1] as unknown[];
    // topology_embedding ($5) must never be null
    expect(params[4]).toMatch(/^\[.*\]$/);
    // intent_embedding ($6) falls back to null on provider failure
    expect(params[5]).toBeNull();
  });

  it('PROCEDURAL_TRIGGER_CONFIG has durable:subscriber type, correct function_id, and topic', () => {
    expect(PROCEDURAL_TRIGGER_CONFIG.type).toBe('durable:subscriber');
    expect(PROCEDURAL_TRIGGER_CONFIG.function_id).toBe('graph::memory::procedural');
    expect(PROCEDURAL_TRIGGER_CONFIG.config.topic).toBe('graph::memory::synthesizer::output');
  });
});
