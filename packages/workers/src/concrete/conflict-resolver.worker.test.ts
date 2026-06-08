import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@graph/shared', () => ({
  writeGuard: vi.fn((s: string) => `[guarded]:${s}`),
}));

import { writeGuard } from '@graph/shared';
import { ConflictResolverWorker } from './conflict-resolver.worker.js';

function makePool(lockResult: boolean) {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) {
        return Promise.resolve({ rows: [{ pg_try_advisory_lock: lockResult }] });
      }
      // pg_advisory_unlock
      return Promise.resolve({ rows: [] });
    }),
  };
}

describe('ConflictResolverWorker', () => {
  let mockChat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChat = vi.fn().mockResolvedValue('merged payload');
  });

  it('acquires lock and returns merged result', async () => {
    const pool = makePool(true);
    const worker = new ConflictResolverWorker({ chat: mockChat }, pool as never);
    const result = await worker.onConflict('entity-fresh', 'payload-A', 'payload-B');

    expect(mockChat).toHaveBeenCalledOnce();
    expect(result).toEqual({ merged: 'merged payload' });
  });

  it('pg_try_advisory_lock returns false → skips without calling LLM', async () => {
    const pool = makePool(false);
    const worker = new ConflictResolverWorker({ chat: mockChat }, pool as never);
    const result = await worker.onConflict('entity-busy', 'A', 'B');

    expect(result).toEqual({ skipped: true });
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('LLM throws → pg_advisory_unlock still called in finally; error propagates', async () => {
    const pool = makePool(true);
    const failingChat = vi.fn().mockRejectedValue(new Error('LLM unavailable'));
    const worker = new ConflictResolverWorker({ chat: failingChat }, pool as never);

    await expect(worker.onConflict('entity-fail', 'A', 'B')).rejects.toThrow('LLM unavailable');
    // unlock must have been called despite the throw
    const unlockCall = (pool.query as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: string[]) => c[0].includes('pg_advisory_unlock'),
    );
    expect(unlockCall).toBeDefined();
  });

  it('calls writeGuard on both payloads before passing to LLM', async () => {
    const pool = makePool(true);
    const worker = new ConflictResolverWorker({ chat: mockChat }, pool as never);
    await worker.onConflict('entity-wg', 'raw-A', 'raw-B');

    expect(vi.mocked(writeGuard)).toHaveBeenCalledWith('raw-A');
    expect(vi.mocked(writeGuard)).toHaveBeenCalledWith('raw-B');
    const chatArg = mockChat.mock.calls[0][0] as { role: string; content: string }[];
    const userMsg = chatArg.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('[guarded]:raw-A');
    expect(userMsg?.content).toContain('[guarded]:raw-B');
  });
});
