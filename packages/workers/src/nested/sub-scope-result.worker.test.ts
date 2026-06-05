import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

vi.mock('@graph/shared', () => ({
  occWrite: vi.fn().mockResolvedValue({
    version_hash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
    event_type: 'memory_updated',
    occ_result: 'won',
  }),
}));

import { occWrite } from '@graph/shared';
import { SubScopeResultWorker, SUB_SCOPE_RESULT_TRIGGER_CONFIG } from './sub-scope-result.worker.js';

const CHILD_SCOPE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const PARENT_SCOPE_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
const TRIGGER_TASK_ID = 'cccccccc-0000-4000-8000-000000000003';
const CHILD_FINAL_HASH = 'a'.repeat(64);
const PARENT_TASK_HASH = 'b'.repeat(64);

const BASE_PAYLOAD = {
  child_scope_id: CHILD_SCOPE_ID,
  trigger_task_id: TRIGGER_TASK_ID,
  child_final_version_hash: CHILD_FINAL_HASH,
  parent_scope_id: PARENT_SCOPE_ID,
};

describe('SubScopeResultWorker', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let pool: Pool;
  let mockChat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChat = vi.fn().mockResolvedValue('synthesized result summary');
    // Default: child node found + parent task_spawned found
    mockQuery = vi.fn()
      .mockResolvedValueOnce({
        rows: [{ payload: { result: 'child done' }, event_type: 'memory_updated' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ version_hash: PARENT_TASK_HASH }],
        rowCount: 1,
      });
    pool = { query: mockQuery } as unknown as Pool;
  });

  it('(a) reads child node by child_final_version_hash from child scope partition', async () => {
    const worker = new SubScopeResultWorker(pool, { chat: mockChat });
    await worker.onSubScopeResolved(BASE_PAYLOAD);

    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('version_hash = $2'),
      [CHILD_SCOPE_ID, CHILD_FINAL_HASH],
    );
  });

  it('(b) calls LLM with child final node content', async () => {
    const worker = new SubScopeResultWorker(pool, { chat: mockChat });
    await worker.onSubScopeResolved(BASE_PAYLOAD);

    expect(mockChat).toHaveBeenCalledOnce();
    const callArgs = mockChat.mock.calls[0][0];
    expect(callArgs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user', content: expect.stringContaining('child done') }),
      ]),
    );
  });

  it('(c) occWrites memory_updated to PARENT scope with result_summary', async () => {
    const worker = new SubScopeResultWorker(pool, { chat: mockChat });
    await worker.onSubScopeResolved(BASE_PAYLOAD);

    expect(vi.mocked(occWrite)).toHaveBeenCalledOnce();
    expect(vi.mocked(occWrite)).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        scopeId: PARENT_SCOPE_ID,
        eventType: 'memory_updated',
        payload: expect.objectContaining({
          sub_scope_resolved: CHILD_SCOPE_ID,
          result_summary: 'synthesized result summary',
          child_final_version_hash: CHILD_FINAL_HASH,
        }),
      }),
    );
  });

  it('(d) child-not-found path writes error memory_updated to parent and does NOT throw', async () => {
    const emptyQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // child not found
      .mockResolvedValueOnce({ rows: [{ version_hash: PARENT_TASK_HASH }], rowCount: 1 });
    const emptyPool = { query: emptyQuery } as unknown as Pool;
    const worker = new SubScopeResultWorker(emptyPool, { chat: mockChat });

    await expect(worker.onSubScopeResolved(BASE_PAYLOAD)).resolves.toBeUndefined();

    expect(mockChat).not.toHaveBeenCalled();
    expect(vi.mocked(occWrite)).toHaveBeenCalledOnce();
    expect(vi.mocked(occWrite)).toHaveBeenCalledWith(
      emptyPool,
      expect.objectContaining({
        scopeId: PARENT_SCOPE_ID,
        eventType: 'memory_updated',
        payload: expect.objectContaining({
          sub_scope_resolved: CHILD_SCOPE_ID,
          result_summary: null,
          error: 'child_final_node_not_found',
        }),
      }),
    );
  });

  it('SUB_SCOPE_RESULT_TRIGGER_CONFIG has correct type, function_id, and topic', () => {
    expect(SUB_SCOPE_RESULT_TRIGGER_CONFIG.type).toBe('durable:subscriber');
    expect(SUB_SCOPE_RESULT_TRIGGER_CONFIG.function_id).toBe('graph::scope::sub-scope-result');
    expect(SUB_SCOPE_RESULT_TRIGGER_CONFIG.config.topic).toBe('graph::scope::sub_scope_resolved');
  });
});
