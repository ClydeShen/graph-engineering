import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import type { LLMProvider } from '@graph/shared';

const mockOccWrite = vi.fn().mockResolvedValue({
  version_hash: 'c'.repeat(64),
  occ_result: 'won',
  event_type: 'memory_updated',
});

vi.mock('@graph/shared', () => ({ occWrite: mockOccWrite }));

function makeMockPool(rows: Array<{ payload: string }>): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Pool;
}

function makeLlm(output = 'synthesized profile'): LLMProvider {
  return { chat: vi.fn().mockResolvedValue(output) };
}

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('UserProfileWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns skipped when fewer than 3 Crystals exist', async () => {
    const pool = makeMockPool([
      { payload: JSON.stringify({ crystal: 'one', source: 'crystallize' }) },
      { payload: JSON.stringify({ crystal: 'two', source: 'crystallize' }) },
    ]);
    const llm = makeLlm();
    const { UserProfileWorker } = await import('./user-profile.worker.js');
    const worker = new UserProfileWorker(pool, llm);
    const result = await worker.synthesize(USER_ID);
    expect(result).toEqual({ skipped: true });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(mockOccWrite).not.toHaveBeenCalled();
  });

  it('calls llm.chat with correct messages when ≥ 3 Crystals exist', async () => {
    const crystals = ['insight A', 'insight B', 'insight C'];
    const pool = makeMockPool(
      crystals.map((c) => ({ payload: JSON.stringify({ crystal: c, source: 'crystallize' }) })),
    );
    const llm = makeLlm('• pattern 1\n• pattern 2');
    const { UserProfileWorker } = await import('./user-profile.worker.js');
    const worker = new UserProfileWorker(pool, llm);
    await worker.synthesize(USER_ID);

    expect(llm.chat).toHaveBeenCalledOnce();
    const [messages] = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0] as [Array<{ role: string; content: string }>];
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('insight A');
  });

  it('calls occWrite with USER_PROFILE_SCOPE_ID and correct payload', async () => {
    const crystals = ['a', 'b', 'c'];
    const pool = makeMockPool(
      crystals.map((c) => ({ payload: JSON.stringify({ crystal: c, source: 'crystallize' }) })),
    );
    const llm = makeLlm('profile summary');
    const { UserProfileWorker, USER_PROFILE_SCOPE_ID } = await import('./user-profile.worker.js');
    const worker = new UserProfileWorker(pool, llm);
    await worker.synthesize(USER_ID);

    expect(mockOccWrite).toHaveBeenCalledOnce();
    const [, args] = mockOccWrite.mock.calls[0] as [
      unknown,
      { scopeId: string; entityId: string; eventType: string; payload: Record<string, unknown> },
    ];
    expect(args.scopeId).toBe(USER_PROFILE_SCOPE_ID);
    expect(args.entityId).toBe(USER_ID);
    expect(args.eventType).toBe('memory_updated');
    expect(args.payload).toMatchObject({
      profile: 'profile summary',
      source: 'user-profile',
      user_id: USER_ID,
      crystal_count: 3,
    });
  });
});
