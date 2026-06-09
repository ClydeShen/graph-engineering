import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { StubTrailReader } from '../base/trail-reader.js';

vi.mock('@graph/shared', () => ({
  writeGuard: vi.fn((s: string) => `[guarded]:${s}`),
}));

import {
  MemorySynthesizerWorker,
  SYNTHESIZER_CRON_TRIGGER,
  DECAY_CRON_TRIGGER,
  TTL_CRON_TRIGGER,
} from './synthesizer.worker.js';

describe('MemorySynthesizerWorker', () => {
  let reader: StubTrailReader;
  let mockQuery: ReturnType<typeof vi.fn>;
  let pool: Pool;
  let mockChat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    pool = { query: mockQuery } as unknown as Pool;
    reader = new StubTrailReader();
    mockChat = vi
      .fn()
      .mockResolvedValue('{"intent_description":"test workflow","steps":["a","b"]}');
  });

  it('runDecay() calls pool.query with SQL containing superseded_by = id and correct WHERE conditions', async () => {
    const worker = new MemorySynthesizerWorker(reader, pool, { chat: mockChat });
    await worker.runDecay();

    expect(mockQuery).toHaveBeenCalledOnce();
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('superseded_by = id');
    expect(sql).toContain('reinforcement_count = 0');
    expect(sql).toContain("INTERVAL '90 days'");
  });

  it('runDecay() — pool throws → error propagates', async () => {
    const failQuery = vi.fn().mockRejectedValue(new Error('db error'));
    const failPool = { query: failQuery } as unknown as Pool;
    const worker = new MemorySynthesizerWorker(reader, failPool, { chat: mockChat });

    await expect(worker.runDecay()).rejects.toThrow('db error');
  });

  it('runTtlPurge() calls pool.query with DELETE FROM working_memory WHERE created_at < NOW() - INTERVAL 24 hours', async () => {
    const worker = new MemorySynthesizerWorker(reader, pool, { chat: mockChat });
    await worker.runTtlPurge();

    expect(mockQuery).toHaveBeenCalledOnce();
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('DELETE FROM working_memory');
    expect(sql).toContain("INTERVAL '24 hours'");
  });

  it('runSynthesis(scopeId) returns { skipped: true } when no episodic records', async () => {
    const worker = new MemorySynthesizerWorker(reader, pool, { chat: mockChat });
    const result = await worker.runSynthesis('sc-1');

    expect(result).toEqual({ skipped: true });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('runSynthesis(scopeId) passes scope_id to reader and returns scope_id from parameter', async () => {
    vi.spyOn(reader, 'getEpisodicRecords').mockResolvedValue(['trace A', 'trace B']);
    const worker = new MemorySynthesizerWorker(reader, pool, { chat: mockChat });

    await worker.runSynthesis('sc-1');
    expect(reader.getEpisodicRecords).toHaveBeenCalledWith('sc-1', { sinceHours: 25, limit: 100 });
  });

  it('runSynthesis(scopeId) returns skipped:false with scope_id from parameter, not from reader', async () => {
    vi.spyOn(reader, 'getEpisodicRecords').mockResolvedValue(['trace A', 'trace B', 'trace C']);
    const worker = new MemorySynthesizerWorker(reader, pool, { chat: mockChat });

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
