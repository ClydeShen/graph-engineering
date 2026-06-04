import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@graph/shared', () => ({
  writeGuard: vi.fn((s: string) => `[guarded]:${s}`),
}));

import { writeGuard } from '@graph/shared';
import { ConflictResolverWorker } from './conflict-resolver.worker.js';

describe('ConflictResolverWorker', () => {
  let mockChat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChat = vi.fn().mockResolvedValue('merged payload');
  });

  it('onConflict with entityId not in registry → calls llm.chat and returns merged result', async () => {
    const worker = new ConflictResolverWorker({ chat: mockChat });
    const result = await worker.onConflict('entity-fresh', 'payload-A', 'payload-B');

    expect(mockChat).toHaveBeenCalledOnce();
    expect(result).toEqual({ merged: 'merged payload' });
  });

  it('onConflict with entityId already resolving → returns { skipped: true } without calling llm.chat', async () => {
    let resolveChat!: (v: string) => void;
    const blockingChat = vi.fn().mockReturnValue(
      new Promise<string>((resolve) => { resolveChat = resolve; }),
    );
    const worker = new ConflictResolverWorker({ chat: blockingChat });

    // First call sets the registry and blocks at LLM
    const firstCall = worker.onConflict('entity-busy', 'A', 'B');
    // Second call for same entity sees registry → skips
    const result = await worker.onConflict('entity-busy', 'C', 'D');

    expect(result).toEqual({ skipped: true });
    expect(blockingChat).toHaveBeenCalledOnce();

    // Clean up first call
    resolveChat('done');
    await firstCall;
  });

  it('LLM throws → registry entry deleted in finally block; error propagates', async () => {
    const failingChat = vi.fn().mockRejectedValue(new Error('LLM unavailable'));
    const worker = new ConflictResolverWorker({ chat: failingChat });

    await expect(worker.onConflict('entity-fail', 'A', 'B')).rejects.toThrow('LLM unavailable');

    // After rejection, registry must be clean — same entity can be resolved again
    const secondChat = vi.fn().mockResolvedValue('retry merged');
    const worker2 = new ConflictResolverWorker({ chat: secondChat });
    const retry = await worker2.onConflict('entity-fail', 'A', 'B');
    expect(retry).toEqual({ merged: 'retry merged' });
  });

  it('ActiveResolverRegistry is module-level: two separate instances share registry state', async () => {
    let resolveChat!: (v: string) => void;
    const blockingChat = vi.fn().mockReturnValue(
      new Promise<string>((resolve) => { resolveChat = resolve; }),
    );
    const worker1 = new ConflictResolverWorker({ chat: blockingChat });
    const worker2 = new ConflictResolverWorker({ chat: vi.fn() });

    // worker1 sets registry and blocks
    const call1 = worker1.onConflict('entity-shared', 'A', 'B');
    // worker2 sees the registry entry set by worker1
    const result2 = await worker2.onConflict('entity-shared', 'C', 'D');

    expect(result2).toEqual({ skipped: true });

    resolveChat('done');
    await call1;
  });

  it('onConflict calls writeGuard on both payloads before passing to LLM', async () => {
    const worker = new ConflictResolverWorker({ chat: mockChat });
    await worker.onConflict('entity-wg', 'raw-A', 'raw-B');

    expect(vi.mocked(writeGuard)).toHaveBeenCalledWith('raw-A');
    expect(vi.mocked(writeGuard)).toHaveBeenCalledWith('raw-B');
    // LLM receives guarded content
    const chatArg = mockChat.mock.calls[0][0] as { role: string; content: string }[];
    const userMsg = chatArg.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('[guarded]:raw-A');
    expect(userMsg?.content).toContain('[guarded]:raw-B');
  });
});
