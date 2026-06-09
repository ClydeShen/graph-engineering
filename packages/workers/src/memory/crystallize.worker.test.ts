import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@graph/shared', () => ({
  writeGuard: vi.fn((s: string) => s),
  occWrite: vi.fn().mockResolvedValue({ version_hash: 'v-hash', occ_result: 'won', event_type: 'memory_updated' }),
  notify: vi.fn().mockResolvedValue(undefined),
}));

import { CrystallizeWorker } from './crystallize.worker.js';

function makePool(rows: { content: string }[]) {
  return {
    query: vi.fn()
      .mockResolvedValueOnce({ rows, rowCount: rows.length })
      .mockResolvedValue({ rows: [], rowCount: 0 }),
  };
}

function makeSdk() {
  return { trigger: vi.fn().mockResolvedValue(undefined) };
}

describe('CrystallizeWorker', () => {
  let mockChat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChat = vi.fn().mockResolvedValue('crystal output');
  });

  it('returns { skipped: true } when no episodic records', async () => {
    const pool = makePool([]);
    const worker = new CrystallizeWorker(pool as never, { chat: mockChat }, makeSdk());
    const result = await worker.onScopeClosed('scope-1', 'entity-1', 'ZERO');

    expect(result).toEqual({ skipped: true });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('fires sdk.trigger with confidence: 0.6 when episodic records exist', async () => {
    const pool = makePool([{ content: 'trace A' }, { content: 'trace B' }]);
    const sdk = makeSdk();
    const worker = new CrystallizeWorker(pool as never, { chat: mockChat }, sdk);

    const result = await worker.onScopeClosed('scope-1', 'entity-1', 'PRED_HASH');

    expect(result).toEqual({ written: true });
    expect(mockChat).toHaveBeenCalledOnce();
    expect(sdk.trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        function_id: 'graph::memory::lesson-save',
        payload: expect.objectContaining({ confidence: 0.6 }),
      }),
    );
  });

  it('passes combined episodic content through writeGuard to LLM', async () => {
    const { writeGuard } = await import('@graph/shared');
    const pool = makePool([{ content: 'trace X' }]);
    const worker = new CrystallizeWorker(pool as never, { chat: mockChat }, makeSdk());

    await worker.onScopeClosed('scope-2', 'entity-2', 'HASH');

    expect(vi.mocked(writeGuard)).toHaveBeenCalledWith('trace X');
  });

  it('passes existing lesson content to LLM when lesson exists', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ content: 'trace A' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ content: 'prior lesson text' }], rowCount: 1 }),
    };
    const sdk = makeSdk();
    const worker = new CrystallizeWorker(pool as never, { chat: mockChat }, sdk);

    await worker.onScopeClosed('scope-3', 'entity-3', 'HASH');

    expect(mockChat).toHaveBeenCalledOnce();
    const [messages] = mockChat.mock.calls[0] as [Array<{ role: string; content: string }>];
    expect(messages[0].content).toContain('ONLY the delta');
    expect(messages[1].content).toContain('EXISTING LESSON:');
  });

  it('uses full prompt when no existing lesson found', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ content: 'trace B' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }),
    };
    const sdk = makeSdk();
    const worker = new CrystallizeWorker(pool as never, { chat: mockChat }, sdk);

    await worker.onScopeClosed('scope-4', 'entity-4', 'HASH');

    expect(mockChat).toHaveBeenCalledOnce();
    const [messages] = mockChat.mock.calls[0] as [Array<{ role: string; content: string }>];
    expect(messages[0].content).toBe('Distill these execution traces into a concise Crystal: key insight, pattern, and recommendation. Be brief.');
  });
});
