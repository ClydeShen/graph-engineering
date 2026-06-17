import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StubTrailReader } from '../base/trail-reader.js';
import { StubMemoryRepository } from '../base/memory-repository.js';

vi.mock('@graph/shared', () => ({
  writeGuard: vi.fn((s: string) => `[guarded]:${s}`),
  contentFingerprint: vi.fn((s: string) => `fp:${s}`),
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  LOG_EVENTS: { MEMORY_METABOLIZED: 'memory.metabolized' },
}));

import {
  MemorySynthesizerWorker,
  SYNTHESIZER_CRON_TRIGGER,
  DECAY_CRON_TRIGGER,
  TTL_CRON_TRIGGER,
} from './synthesizer.worker.js';

describe('MemorySynthesizerWorker', () => {
  let reader: StubTrailReader;
  let memory: StubMemoryRepository;
  let mockChat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    memory = new StubMemoryRepository();
    reader = new StubTrailReader();
    mockChat = vi
      .fn()
      .mockResolvedValue('{"intent_description":"test workflow","steps":["a","b"]}');
  });

  it('runDecay() runs atrophy AND evidence-gated apoptosis on the same sweep (GH #32)', async () => {
    memory.setMetabolismRows([
      { id: 'bad-tpl', success_count: 0, failure_count: 9, quality_score: 0.1 },
    ]);
    const worker = new MemorySynthesizerWorker(reader, memory, { chat: mockChat });
    await worker.runDecay();

    expect(memory.calls.markSupersededByEbbinghaus).toBe(1); // atrophy
    expect(memory.calls.metabolizeByEvidence).toHaveLength(1); // apoptosis
    expect(memory.calls.metabolizeByEvidence[0]).toEqual({ nMin: 5, qualityBad: 0.3 });
  });

  it('runDecay() — memory throws → error propagates', async () => {
    memory.throwOn('markSupersededByEbbinghaus');
    const worker = new MemorySynthesizerWorker(reader, memory, { chat: mockChat });

    await expect(worker.runDecay()).rejects.toThrow('db error');
  });

  it('runTtlPurge() calls memory.purgeTTLWorkingMemory once', async () => {
    const worker = new MemorySynthesizerWorker(reader, memory, { chat: mockChat });
    await worker.runTtlPurge();

    expect(memory.calls.purgeTTLWorkingMemory).toBe(1);
  });

  it('runTtlPurge() — memory throws → error propagates', async () => {
    memory.throwOn('purgeTTLWorkingMemory');
    const worker = new MemorySynthesizerWorker(reader, memory, { chat: mockChat });

    await expect(worker.runTtlPurge()).rejects.toThrow('db error');
  });

  it('runSynthesis(scopeId) returns { skipped: true } when no episodic records', async () => {
    const worker = new MemorySynthesizerWorker(reader, memory, { chat: mockChat });
    const result = await worker.runSynthesis('sc-1');

    expect(result).toEqual({ skipped: true });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('runSynthesis(scopeId) passes scope_id to reader', async () => {
    vi.spyOn(reader, 'getEpisodicRecords').mockResolvedValue(['trace A', 'trace B']);
    const worker = new MemorySynthesizerWorker(reader, memory, { chat: mockChat });

    await worker.runSynthesis('sc-1');
    expect(reader.getEpisodicRecords).toHaveBeenCalledWith('sc-1', { sinceHours: 25, limit: 100 });
  });

  it('runSynthesis(scopeId) returns skipped:false with scope_id from parameter', async () => {
    vi.spyOn(reader, 'getEpisodicRecords').mockResolvedValue(['trace A', 'trace B', 'trace C']);
    const worker = new MemorySynthesizerWorker(reader, memory, { chat: mockChat });

    const result = await worker.runSynthesis('sc-PARAM');
    const r = result as {
      skipped: false;
      scope_id: string;
      intent_description: string;
      nodes: unknown[];
      edges: unknown[];
    };
    expect(r.skipped).toBe(false);
    expect(r.scope_id).toBe('sc-PARAM');
    expect(r.nodes).toHaveLength(3);
    expect(r.edges).toHaveLength(2);
    expect(r.intent_description).toBe('test workflow');
  });

  it('cron trigger configs have correct types and expressions', () => {
    expect(SYNTHESIZER_CRON_TRIGGER.type).toBe('cron');
    expect(SYNTHESIZER_CRON_TRIGGER.config.expression).toBe('0 0 2 * * * *');
    expect(DECAY_CRON_TRIGGER.config.expression).toBe('0 0 3 * * * *');
    expect(TTL_CRON_TRIGGER.config.expression).toBe('0 0 4 * * * *');
  });
});
