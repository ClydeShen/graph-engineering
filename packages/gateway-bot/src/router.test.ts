import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

const mockOccWrite = vi.fn().mockResolvedValue({
  version_hash: 'b'.repeat(64),
  occ_result: 'won',
  event_type: 'task_spawned',
});

vi.mock('@graph/shared', () => ({ occWrite: mockOccWrite }));

describe('dispatchMessage router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes source_message_id in the task_spawned payload', async () => {
    const pool = {} as Pool;
    const { dispatchMessage } = await import('./router.js');
    const taskId = await dispatchMessage(
      'telegram::123456',
      'hello',
      pool,
      'update-id-999',
    );

    expect(typeof taskId).toBe('string');
    expect(taskId.length).toBeGreaterThan(0);

    expect(mockOccWrite).toHaveBeenCalledOnce();
    const [, args] = mockOccWrite.mock.calls[0] as [unknown, { payload: Record<string, unknown>; eventType: string }];
    expect(args.eventType).toBe('task_spawned');
    expect(args.payload).toMatchObject({
      source: 'telegram::123456',
      text: 'hello',
      required_skills: ['message-handler'],
      source_message_id: 'update-id-999',
    });
    expect(typeof args.payload['task_id']).toBe('string');
  });

  it('returns the task_id from the payload', async () => {
    const pool = {} as Pool;
    const { dispatchMessage } = await import('./router.js');
    const taskId = await dispatchMessage('discord::ch1', 'test', pool, 'int-1');
    expect(typeof taskId).toBe('string');
  });
});
