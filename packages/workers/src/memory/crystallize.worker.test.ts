import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventWriter } from '@graph/shared';
import { StubTrailReader } from '../base/trail-reader.js';
import { StubMemoryRepository } from '../base/memory-repository.js';

vi.mock('@graph/shared', () => ({
  writeGuard: vi.fn((s: string) => s),
  notify: vi.fn().mockResolvedValue(undefined),
}));

import { CrystallizeWorker } from './crystallize.worker.js';

function makeWriter(): EventWriter & { write: ReturnType<typeof vi.fn> } {
  return {
    write: vi.fn().mockResolvedValue({ version_hash: 'v-hash', occ_result: 'won', event_type: 'memory_updated' }),
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
    const reader = new StubTrailReader();
    const memory = new StubMemoryRepository();
    const writer = makeWriter();
    const worker = new CrystallizeWorker(reader, memory, writer, { chat: mockChat }, makeSdk());
    const result = await worker.onScopeClosed('scope-1', 'entity-1', 'ZERO');

    expect(result).toEqual({ skipped: true });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('fires sdk.trigger with confidence: 0.6 when episodic records exist', async () => {
    const reader = new StubTrailReader();
    vi.spyOn(reader, 'getEpisodicRecords').mockResolvedValue(['trace A', 'trace B']);
    const memory = new StubMemoryRepository();
    const sdk = makeSdk();
    const writer = makeWriter();
    const worker = new CrystallizeWorker(reader, memory, writer, { chat: mockChat }, sdk);

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
    const memory = new StubMemoryRepository();
    const writer = makeWriter();
    const worker = new CrystallizeWorker(reader, memory, writer, { chat: mockChat }, makeSdk());

    await worker.onScopeClosed('scope-2', 'entity-2', 'HASH');

    expect(vi.mocked(writeGuard)).toHaveBeenCalledWith('trace X');
  });

  it('uses delta prompt when existing lesson found via memory.lookupLesson', async () => {
    const reader = new StubTrailReader();
    vi.spyOn(reader, 'getEpisodicRecords').mockResolvedValue(['new trail event']);
    const memory = new StubMemoryRepository();
    memory.setLookupLesson({ fingerprintId: 'fp', confidence: 0.5, content: 'prior lesson text' });
    const writer = makeWriter();
    const worker = new CrystallizeWorker(reader, memory, writer, { chat: mockChat }, makeSdk());

    await worker.onScopeClosed('scope-3', 'entity-3', 'HASH');

    const [messages] = mockChat.mock.calls[0];
    expect(messages[0].content).toContain('ONLY the delta');
    expect(messages[1].content).toContain('EXISTING LESSON:');
  });

  it('uses full distillation prompt when no existing lesson in memory', async () => {
    const reader = new StubTrailReader();
    vi.spyOn(reader, 'getEpisodicRecords').mockResolvedValue(['fresh trace']);
    const memory = new StubMemoryRepository();
    const writer = makeWriter();
    const worker = new CrystallizeWorker(reader, memory, writer, { chat: mockChat }, makeSdk());

    await worker.onScopeClosed('scope-4', 'entity-4', 'HASH');

    const [messages] = mockChat.mock.calls[0];
    expect(messages[0].content).toBe('Distill these execution traces into a concise Crystal: key insight, pattern, and recommendation. Be brief.');
  });
});
