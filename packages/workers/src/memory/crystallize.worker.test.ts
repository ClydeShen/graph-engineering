import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StubTrailReader } from '../base/trail-reader.js';

vi.mock('@graph/shared', () => ({
  writeGuard: vi.fn((s: string) => s),
  occWrite: vi.fn().mockResolvedValue({ version_hash: 'v-hash', occ_result: 'won', event_type: 'memory_updated' }),
  notify: vi.fn().mockResolvedValue(undefined),
}));

import { CrystallizeWorker } from './crystallize.worker.js';

const mockPool = { query: vi.fn() } as never;

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
    const reader = new StubTrailReader(); // returns [] by default
    const worker = new CrystallizeWorker(reader, mockPool, { chat: mockChat }, makeSdk());
    const result = await worker.onScopeClosed('scope-1', 'entity-1', 'ZERO');

    expect(result).toEqual({ skipped: true });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('fires sdk.trigger with confidence: 0.6 when episodic records exist', async () => {
    const reader = new StubTrailReader();
    vi.spyOn(reader, 'getEpisodicRecords').mockResolvedValue(['trace A', 'trace B']);
    const sdk = makeSdk();
    const worker = new CrystallizeWorker(reader, mockPool, { chat: mockChat }, sdk);

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
    const reader = new StubTrailReader();
    vi.spyOn(reader, 'getEpisodicRecords').mockResolvedValue(['trace X']);
    const worker = new CrystallizeWorker(reader, mockPool, { chat: mockChat }, makeSdk());

    await worker.onScopeClosed('scope-2', 'entity-2', 'HASH');

    expect(vi.mocked(writeGuard)).toHaveBeenCalledWith('trace X');
  });
});
